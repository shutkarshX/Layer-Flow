// Audio device switcher — lists active output (render) and input (capture)
// endpoints and sets the system default. Windows has no public API for setting
// the default device, so we use the undocumented IPolicyConfig COM interface
// (the same approach NirCmd / SoundSwitch / AudioDeviceCmdlets use).

#[derive(serde::Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioSpectrum {
    pub bins: Vec<f32>,
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    pub volume: f32,
    pub is_active: bool,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    /// "output" (render) or "input" (capture)
    pub direction: String,
    pub is_default: bool,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioSession {
    /// Stable per-session-instance id (not the pid — a process can own more
    /// than one session, e.g. one per browser tab), used to target a single
    /// slider on the next set_session_volume/mute call.
    pub id: String,
    pub pid: u32,
    pub name: String,
    pub volume: f32,
    pub muted: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::AudioDevice;
    use windows::core::{Interface, GUID, HRESULT, PCWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, eMultimedia, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
        STGM_READ,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;

    fn com_init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    unsafe fn default_id(enumr: &IMMDeviceEnumerator, flow: EDataFlow) -> Option<String> {
        let dev = enumr.GetDefaultAudioEndpoint(flow, eConsole).ok()?;
        let id = dev.GetId().ok()?;
        let s = id.to_string().ok();
        CoTaskMemFree(Some(id.0 as *const _));
        s
    }

    unsafe fn list_flow(
        enumr: &IMMDeviceEnumerator,
        flow: EDataFlow,
        dir: &str,
        out: &mut Vec<AudioDevice>,
    ) {
        let def = default_id(enumr, flow);
        let coll = match enumr.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) {
            Ok(c) => c,
            Err(_) => return,
        };
        let count = coll.GetCount().unwrap_or(0);
        for i in 0..count {
            let Ok(dev) = coll.Item(i) else { continue };
            let id = match dev.GetId() {
                Ok(p) => {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as *const _));
                    s
                }
                Err(_) => continue,
            };
            let name = friendly_name(&dev).unwrap_or_else(|| "Unknown device".into());
            out.push(AudioDevice {
                is_default: def.as_deref() == Some(id.as_str()),
                id,
                name,
                direction: dir.to_string(),
            });
        }
    }

    unsafe fn friendly_name(dev: &windows::Win32::Media::Audio::IMMDevice) -> Option<String> {
        let store = dev.OpenPropertyStore(STGM_READ).ok()?;
        let mut pv = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let mut result = None;
        if pv.Anonymous.Anonymous.vt == VT_LPWSTR {
            result = pv.Anonymous.Anonymous.Anonymous.pwszVal.to_string().ok();
        }
        let _ = PropVariantClear(&mut pv);
        result
    }

    pub fn list() -> Vec<AudioDevice> {
        com_init();
        let mut out = Vec::new();
        unsafe {
            if let Ok(enumr) =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            {
                list_flow(&enumr, eRender, "output", &mut out);
                list_flow(&enumr, eCapture, "input", &mut out);
            }
        }
        out
    }

    // ---- Per-app session volumes (IAudioSessionManager2) ------------------
    use super::AudioSession;
    use windows::Win32::Media::Audio::{
        IAudioSessionControl2, IAudioSessionManager2, ISimpleAudioVolume, AudioSessionStateExpired,
    };

    unsafe fn session_manager() -> windows::core::Result<IAudioSessionManager2> {
        let enumr: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumr.GetDefaultAudioEndpoint(eRender, eConsole)?;
        device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
    }

    // Display name for a pid: the exe's FileDescription (what Windows' own
    // mixer shows, e.g. "Google Chrome"), falling back to the process name.
    // Cached per exe path — the widget polls every 1.5s and version resources
    // never change for a given file.
    fn process_name(pid: u32) -> Option<String> {
        use std::collections::HashMap;
        use std::path::PathBuf;
        use std::sync::{Mutex, OnceLock};
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

        static CACHE: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();

        let pid = Pid::from_u32(pid);
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        let proc_ = sys.process(pid)?;
        let raw = proc_.name().to_string_lossy().to_string();
        let fallback = raw.strip_suffix(".exe").unwrap_or(&raw).to_string();
        let Some(exe) = proc_.exe().map(|p| p.to_path_buf()) else {
            return Some(fallback);
        };

        let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Some(hit) = cache.lock().ok().and_then(|c| c.get(&exe).cloned()) {
            return Some(hit);
        }
        let name = unsafe { file_description(&exe) }.unwrap_or(fallback);
        if let Ok(mut c) = cache.lock() {
            c.insert(exe, name.clone());
        }
        Some(name)
    }

    unsafe fn file_description(path: &std::path::Path) -> Option<String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{
            GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
        };

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let file = PCWSTR(wide.as_ptr());
        let size = GetFileVersionInfoSizeW(file, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(file, None, size, data.as_mut_ptr() as *mut _).ok()?;

        let query = |sub: &str| -> Option<(*const u8, u32)> {
            let sub_w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
            let mut ptr: *mut core::ffi::c_void = core::ptr::null_mut();
            let mut len: u32 = 0;
            let ok = VerQueryValueW(
                data.as_ptr() as *const _,
                PCWSTR(sub_w.as_ptr()),
                &mut ptr,
                &mut len,
            );
            (ok.as_bool() && !ptr.is_null() && len > 0).then_some((ptr as *const u8, len))
        };

        // Prefer the file's own declared language/codepage, then US English.
        let mut langs: Vec<String> = Vec::new();
        if let Some((p, len)) = query("\\VarFileInfo\\Translation") {
            let pairs = std::slice::from_raw_parts(p as *const u16, (len / 2) as usize);
            for pair in pairs.chunks_exact(2) {
                langs.push(format!("{:04x}{:04x}", pair[0], pair[1]));
            }
        }
        langs.extend(["040904b0".into(), "040904e4".into()]);

        for lang in langs {
            if let Some((p, len)) = query(&format!("\\StringFileInfo\\{lang}\\FileDescription")) {
                // len is in characters, including the trailing NUL.
                let chars = std::slice::from_raw_parts(p as *const u16, len as usize);
                let s = String::from_utf16_lossy(chars);
                let s = s.trim_end_matches('\0').trim();
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    }

    unsafe fn each_session(
        mut f: impl FnMut(&IAudioSessionControl2, &ISimpleAudioVolume, u32) -> bool,
    ) -> bool {
        com_init();
        let Ok(mgr) = session_manager() else { return false };
        let Ok(sessions) = mgr.GetSessionEnumerator() else { return false };
        let count = sessions.GetCount().unwrap_or(0);
        for i in 0..count {
            let Ok(ctrl) = sessions.GetSession(i) else { continue };
            let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else { continue };
            if matches!(ctrl2.GetState(), Ok(s) if s == AudioSessionStateExpired) {
                continue;
            }
            let Ok(vol) = ctrl2.cast::<ISimpleAudioVolume>() else { continue };
            let pid = ctrl2.GetProcessId().unwrap_or(0);
            if f(&ctrl2, &vol, pid) {
                return true;
            }
        }
        false
    }

    pub fn list_sessions() -> Vec<AudioSession> {
        let mut out: Vec<AudioSession> = Vec::new();
        unsafe {
            each_session(|ctrl2, vol, pid| {
                let is_system = pid == 0;
                let id = ctrl2
                    .GetSessionInstanceIdentifier()
                    .ok()
                    .and_then(|p| {
                        let s = p.to_string().ok();
                        CoTaskMemFree(Some(p.0 as *const _));
                        s
                    })
                    .unwrap_or_else(|| format!("pid-{pid}"));
                let name = if is_system {
                    "System Sounds".to_string()
                } else {
                    process_name(pid).unwrap_or_else(|| format!("PID {pid}"))
                };
                let volume = vol.GetMasterVolume().unwrap_or(-1.0);
                if volume < 0.0 {
                    return false;
                }
                let muted = vol.GetMute().map(|b| b.as_bool()).unwrap_or(false);
                out.push(AudioSession {
                    id,
                    pid,
                    name,
                    volume,
                    muted,
                });
                false
            });
        }
        out
    }

    pub fn set_session_volume(id: &str, level: f32) -> bool {
        let level = level.clamp(0.0, 1.0);
        unsafe {
            each_session(|ctrl2, vol, pid| {
                if session_matches(ctrl2, id, pid) {
                    let _ = vol.SetMasterVolume(level, std::ptr::null());
                    return true;
                }
                false
            })
        }
    }

    pub fn set_session_mute(id: &str, muted: bool) -> bool {
        unsafe {
            each_session(|ctrl2, vol, pid| {
                if session_matches(ctrl2, id, pid) {
                    let _ = vol.SetMute(muted, std::ptr::null());
                    return true;
                }
                false
            })
        }
    }

    unsafe fn session_matches(ctrl2: &IAudioSessionControl2, id: &str, pid: u32) -> bool {
        let this_id = ctrl2
            .GetSessionInstanceIdentifier()
            .ok()
            .and_then(|p| {
                let s = p.to_string().ok();
                CoTaskMemFree(Some(p.0 as *const _));
                s
            })
            .unwrap_or_else(|| format!("pid-{pid}"));
        this_id == id
    }

    // ---- IPolicyConfig (undocumented) -------------------------------------
    const CLSID_POLICY_CONFIG_CLIENT: GUID =
        GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const IID_IPOLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);

    // Vtable layout of IPolicyConfig. We only call SetDefaultEndpoint (entry 14:
    // 3 IUnknown slots + 10 IPolicyConfig methods before it); the rest are left
    // opaque so we never have to model their signatures.
    #[repr(C)]
    struct IPolicyConfigVtbl {
        query_interface: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *const GUID,
            *mut *mut core::ffi::c_void,
        ) -> HRESULT,
        add_ref: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
        release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
        _get_mix_format: usize,
        _get_device_format: usize,
        _reset_device_format: usize,
        _set_device_format: usize,
        _get_processing_period: usize,
        _set_processing_period: usize,
        _get_share_mode: usize,
        _set_share_mode: usize,
        _get_property_value: usize,
        _set_property_value: usize,
        set_default_endpoint:
            unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32) -> HRESULT,
        _set_endpoint_visibility: usize,
    }

    pub fn set_default(device_id: &str) -> bool {
        com_init();
        let id_w: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let unknown: windows::core::IUnknown =
                match CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL) {
                    Ok(u) => u,
                    Err(_) => return false,
                };
            let mut ppv: *mut core::ffi::c_void = core::ptr::null_mut();
            let hr = (Interface::vtable(&unknown).QueryInterface)(
                unknown.as_raw(),
                &IID_IPOLICY_CONFIG,
                &mut ppv,
            );
            if hr.is_err() || ppv.is_null() {
                return false;
            }
            let vtbl = *(ppv as *mut *mut IPolicyConfigVtbl);
            let set_default_endpoint = (*vtbl).set_default_endpoint;
            let mut ok = true;
            // eConsole = 0, eMultimedia = 1, eCommunications = 2 — set all roles.
            for role in [0i32, 1, 2] {
                if set_default_endpoint(ppv, PCWSTR(id_w.as_ptr()), role).is_err() {
                    ok = false;
                }
            }
            ((*vtbl).release)(ppv);
            ok
        }
    }
    static AUDIO_PEAK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    use super::AudioSpectrum;
    use std::sync::OnceLock;

    static AUDIO_SPECTRUM: OnceLock<std::sync::Mutex<AudioSpectrum>> = OnceLock::new();

    fn spectrum_store() -> &'static std::sync::Mutex<AudioSpectrum> {
        AUDIO_SPECTRUM.get_or_init(|| {
            std::sync::Mutex::new(AudioSpectrum {
                bins: vec![0.0; 32],
                bass: 0.0,
                mid: 0.0,
                treble: 0.0,
                volume: 0.0,
                is_active: false,
            })
        })
    }

    pub fn get_audio_spectrum() -> AudioSpectrum {
        if let Ok(guard) = spectrum_store().lock() {
            guard.clone()
        } else {
            AudioSpectrum {
                bins: vec![0.0; 32],
                bass: 0.0,
                mid: 0.0,
                treble: 0.0,
                volume: 0.0,
                is_active: false,
            }
        }
    }

    pub fn get_audio_peak() -> f32 {
        f32::from_bits(AUDIO_PEAK.load(std::sync::atomic::Ordering::Relaxed))
    }

    // In-place Cooley-Tukey Radix-2 FFT (Zero allocations, microsecond execution)
    fn fft_radix2(buf: &mut [(f32, f32)]) {
        let n = buf.len();
        if n <= 1 { return; }
        let mut j = 0;
        for i in 0..n {
            if i < j {
                buf.swap(i, j);
            }
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let angle = -2.0 * std::f32::consts::PI / (len as f32);
            let w_step = (angle.cos(), angle.sin());
            for i in (0..n).step_by(len) {
                let mut w = (1.0f32, 0.0f32);
                for k in 0..half {
                    let u = buf[i + k];
                    let v = (
                        buf[i + k + half].0 * w.0 - buf[i + k + half].1 * w.1,
                        buf[i + k + half].0 * w.1 + buf[i + k + half].1 * w.0,
                    );
                    buf[i + k] = (u.0 + v.0, u.1 + v.1);
                    buf[i + k + half] = (u.0 - v.0, u.1 - v.1);
                    w = (w.0 * w_step.0 - w.1 * w_step.1, w.0 * w_step.1 + w.1 * w_step.0);
                }
            }
            len <<= 1;
        }
    }

    pub fn start_audio_meter(app: tauri::AppHandle) {
        use std::sync::atomic::Ordering;
        use std::time::Duration;
        use tauri::Emitter;
        use tauri::Manager;
        use windows::Win32::Media::Audio::{
            IAudioClient, IAudioCaptureClient, AUDCLNT_SHAREMODE_SHARED, WAVEFORMATEX,
        };

        const AUDCLNT_STREAMFLAGS_LOOPBACK: u32 = 0x00020000;
        const AUDCLNT_BUFFERFLAGS_SILENT: u32 = 0x2;

        std::thread::Builder::new()
            .name("audio-loopback-fft".into())
            .spawn(move || {
                com_init();

                let mut pcm_ring = [0.0f32; 512];
                let mut ring_idx = 0usize;
                let mut smooth_bins = [0.0f32; 32];
                let mut windowed = [(0.0f32, 0.0f32); 512];
                let mut client_opt: Option<(IAudioClient, IAudioCaptureClient, u16, u16)> = None;
                let mut stale_counter = 0u32;

                // 32 Logarithmic frequency band boundaries across 256 positive FFT bins
                const BAND_BOUNDS: [(usize, usize); 32] = [
                    (1, 2),    // Band 0:  ~94 Hz (Deep Sub-bass)
                    (2, 3),    // Band 1:  ~140 Hz (Punchy Kick drum fundamental!)
                    (3, 4),    // Band 2:  ~187 Hz (Bass note fundamental)
                    (4, 5),    // Band 3:  ~234 Hz
                    (5, 6),    // Band 4:  ~281 Hz
                    (6, 7),    // Band 5:  ~328 Hz
                    (7, 8),    // Band 6:  ~375 Hz
                    (8, 10),   // Band 7:  ~375-468 Hz
                    (10, 12),  // Band 8:  ~468-562 Hz
                    (12, 14),  // Band 9:  ~562-656 Hz
                    (14, 17),  // Band 10: ~656-796 Hz
                    (17, 20),  // Band 11: ~796-937 Hz
                    (20, 24),  // Band 12: ~937-1125 Hz (Vocal range)
                    (24, 28),  // Band 13: ~1.1-1.3 kHz
                    (28, 33),  // Band 14: ~1.3-1.5 kHz
                    (33, 39),  // Band 15: ~1.5-1.8 kHz
                    (39, 45),  // Band 16: ~1.8-2.1 kHz
                    (45, 52),  // Band 17: ~2.1-2.4 kHz
                    (52, 60),  // Band 18: ~2.4-2.8 kHz
                    (60, 69),  // Band 19: ~2.8-3.2 kHz
                    (69, 79),  // Band 20: ~3.2-3.7 kHz (Snare attack)
                    (79, 90),  // Band 21: ~3.7-4.2 kHz
                    (90, 103), // Band 22: ~4.2-4.8 kHz
                    (103, 117),// Band 23: ~4.8-5.5 kHz
                    (117, 133),// Band 24: ~5.5-6.2 kHz
                    (133, 151),// Band 25: ~6.2-7.1 kHz
                    (151, 171),// Band 26: ~7.1-8.0 kHz
                    (171, 193),// Band 27: ~8.0-9.0 kHz (Hi-hats, cymbals)
                    (193, 217),// Band 28: ~9.0-10.2 kHz
                    (217, 230),// Band 29: ~10.2-10.8 kHz
                    (230, 243),// Band 30: ~10.8-11.4 kHz
                    (243, 256),// Band 31: ~11.4-12.0 kHz (Brilliance/Air)
                ];

                loop {
                    // 1. Maintain active WASAPI Loopback client on current default audio device
                    if client_opt.is_none() {
                        unsafe {
                            let enumr_res: windows::core::Result<IMMDeviceEnumerator> =
                                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL);
                            if let Ok(enumr) = enumr_res {
                                let dev = enumr.GetDefaultAudioEndpoint(eRender, eMultimedia)
                                    .or_else(|_| enumr.GetDefaultAudioEndpoint(eRender, eConsole));
                                if let Ok(dev) = dev {
                                    if let Ok(client) = dev.Activate::<IAudioClient>(CLSCTX_ALL, None) {
                                        if let Ok(pwfx) = client.GetMixFormat() {
                                            let channels = (*pwfx).nChannels;
                                            let bits = (*pwfx).wBitsPerSample;
                                            let hr = client.Initialize(
                                                AUDCLNT_SHAREMODE_SHARED,
                                                AUDCLNT_STREAMFLAGS_LOOPBACK,
                                                1_000_000,
                                                0,
                                                pwfx,
                                                None,
                                            );
                                            CoTaskMemFree(Some(pwfx as *const _));
                                            if hr.is_ok() {
                                                if let Ok(capture) = client.GetService::<IAudioCaptureClient>() {
                                                    if client.Start().is_ok() {
                                                        client_opt = Some((client, capture, channels, bits));
                                                        stale_counter = 0;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // 2. Read PCM sample frames from loopback buffer
                    let mut frames_read = 0usize;
                    if let Some((_, capture, channels, bits)) = &client_opt {
                        let channels = *channels as usize;
                        let bits = *bits;
                        unsafe {
                            let mut p_data: *mut u8 = std::ptr::null_mut();
                            let mut num_frames: u32 = 0;
                            let mut flags: u32 = 0;

                            while capture.GetBuffer(&mut p_data, &mut num_frames, &mut flags, None, None).is_ok() {
                                if num_frames == 0 {
                                    break;
                                }
                                if !p_data.is_null() && (flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 {
                                    if bits == 32 {
                                        let samples = std::slice::from_raw_parts(p_data as *const f32, num_frames as usize * channels);
                                        for frame in 0..num_frames as usize {
                                            let mut sum = 0.0f32;
                                            for ch in 0..channels {
                                                sum += samples[frame * channels + ch];
                                            }
                                            pcm_ring[ring_idx] = sum / channels as f32;
                                            ring_idx = (ring_idx + 1) % 512;
                                            frames_read += 1;
                                        }
                                    } else if bits == 16 {
                                        let samples = std::slice::from_raw_parts(p_data as *const i16, num_frames as usize * channels);
                                        for frame in 0..num_frames as usize {
                                            let mut sum = 0.0f32;
                                            for ch in 0..channels {
                                                sum += samples[frame * channels + ch] as f32;
                                            }
                                            pcm_ring[ring_idx] = sum / (channels as f32 * 32768.0);
                                            ring_idx = (ring_idx + 1) % 512;
                                            frames_read += 1;
                                        }
                                    }
                                }
                                let _ = capture.ReleaseBuffer(num_frames);
                            }
                        }
                    }

                    if frames_read == 0 {
                        stale_counter += 1;
                        if stale_counter > 100 {
                            // Device may have changed or gone to sleep — refresh loopback
                            client_opt = None;
                            stale_counter = 0;
                        }
                    } else {
                        stale_counter = 0;
                    }

                    // 3. Compute Hann Window, RMS amplitude and FFT
                    let mut rms_sum = 0.0f32;
                    let mut peak_val = 0.0f32;
                    for i in 0..512 {
                        let s = pcm_ring[(ring_idx + i) % 512];
                        rms_sum += s * s;
                        let abs_s = s.abs();
                        if abs_s > peak_val {
                            peak_val = abs_s;
                        }
                        // Hann window to minimize spectral leakage
                        let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / 512.0).cos());
                        windowed[i] = (s * w, 0.0);
                    }
                    let rms = (rms_sum / 512.0).sqrt();

                    // Run in-place Radix-2 FFT
                    fft_radix2(&mut windowed);

                    // Compute magnitudes across positive frequency bins 0..256
                    let mut mags = [0.0f32; 256];
                    for k in 0..256 {
                        mags[k] = (windowed[k].0 * windowed[k].0 + windowed[k].1 * windowed[k].1).sqrt() / 128.0;
                    }

                    // Map 256 frequency bins into 32 perceptual logarithmic bands
                    let mut raw_bins = [0.0f32; 32];
                    for b in 0..32 {
                        let (start, end) = BAND_BOUNDS[b];
                        let mut sum = 0.0f32;
                        for k in start..end {
                            sum += mags[k];
                        }
                        let count = (end - start).max(1) as f32;
                        let weight = if b < 4 { 2.6 } else if b < 12 { 1.9 } else { 1.4 };
                        raw_bins[b] = (sum / count * weight).min(1.0);
                    }

                    // Dynamic smoothing: instant explosive attack, smooth musical decay
                    for b in 0..32 {
                        let target = raw_bins[b];
                        let cur = smooth_bins[b];
                        if target > cur {
                            smooth_bins[b] = cur + (target - cur) * 0.88;
                        } else {
                            smooth_bins[b] = cur * 0.82;
                        }
                    }

                    // Calculate genuine composite frequency energies
                    let bass = ((smooth_bins[0] + smooth_bins[1] + smooth_bins[2] + smooth_bins[3] + smooth_bins[4]) / 5.0).min(1.0);
                    let mid = (smooth_bins[5..19].iter().sum::<f32>() / 14.0).min(1.0);
                    let treble = (smooth_bins[19..32].iter().sum::<f32>() / 13.0).min(1.0);
                    let is_active = rms > 0.0008 || peak_val > 0.002;

                    // Update atomic peak
                    let eff_peak = peak_val.max(bass * 0.95);
                    AUDIO_PEAK.store(eff_peak.to_bits(), Ordering::Relaxed);

                    // Update global spectrum store
                    let spec = AudioSpectrum {
                        bins: smooth_bins.to_vec(),
                        bass,
                        mid,
                        treble,
                        volume: rms.min(1.0),
                        is_active,
                    };

                    if let Ok(mut guard) = spectrum_store().lock() {
                        *guard = spec.clone();
                    }

                    // Emit to frontend listeners
                    let _ = app.emit("audio-spectrum", &spec);
                    let _ = app.emit("audio-peak", eff_peak);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.emit("audio-spectrum", &spec);
                        let _ = w.emit("audio-peak", eff_peak);
                    }

                    std::thread::sleep(Duration::from_millis(20));
                }
            })
            .ok();
    }

}

#[cfg(target_os = "windows")]
pub fn list_devices() -> Vec<AudioDevice> {
    imp::list()
}
#[cfg(target_os = "windows")]
pub fn set_default_device(id: &str) -> bool {
    imp::set_default(id)
}

#[cfg(target_os = "windows")]
pub fn list_sessions() -> Vec<AudioSession> {
    imp::list_sessions()
}
#[cfg(target_os = "windows")]
pub fn set_session_volume(id: &str, level: f32) -> bool {
    imp::set_session_volume(id, level)
}
#[cfg(target_os = "windows")]
pub fn set_session_mute(id: &str, muted: bool) -> bool {
    imp::set_session_mute(id, muted)
}
#[cfg(target_os = "windows")]
pub fn get_audio_peak() -> f32 {
    imp::get_audio_peak()
}
#[cfg(target_os = "windows")]
pub fn get_audio_spectrum() -> AudioSpectrum {
    imp::get_audio_spectrum()
}
#[cfg(target_os = "windows")]
pub fn start_audio_meter(app: tauri::AppHandle) {
    imp::start_audio_meter(app);
}

#[cfg(not(target_os = "windows"))]
pub fn list_devices() -> Vec<AudioDevice> {
    Vec::new()
}
#[cfg(not(target_os = "windows"))]
pub fn set_default_device(_id: &str) -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn list_sessions() -> Vec<AudioSession> {
    Vec::new()
}
#[cfg(not(target_os = "windows"))]
pub fn set_session_volume(_id: &str, _level: f32) -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn set_session_mute(_id: &str, _muted: bool) -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn get_audio_peak() -> f32 {
    0.0
}
#[cfg(not(target_os = "windows"))]
pub fn get_audio_spectrum() -> AudioSpectrum {
    AudioSpectrum {
        bins: vec![0.0; 32],
        bass: 0.0,
        mid: 0.0,
        treble: 0.0,
        volume: 0.0,
        is_active: false,
    }
}
#[cfg(not(target_os = "windows"))]
pub fn start_audio_meter(_app: tauri::AppHandle) {}


