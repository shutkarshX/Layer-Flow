import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'framer-motion'
import { Music, Play, Pause, SkipBack, SkipForward, Volume1, Volume2, VolumeX, Repeat, Mic2, Move } from 'lucide-react'
import {
  getNowPlaying,
  getVolume,
  getWallpaperAccent,
  isTauri,
  mediaControl,
  mediaSeek,
  mediaRepeat,
  setVolume,
  type NowPlaying,
} from '../../lib/ipc'
import type {
  NowPlayingWidget as NowPlayingWidgetType,
  VisualizerType,
  ProgressBarStyle,
  LyricsStyle,
  VolumeStyle,
  ArtDesign,
  ArtLayout,
  LayoutSizing,
  ControlsLayout,
  InfoAlignment,
  InfoTypography,
  InfoDensity,
  WidgetElementKey,
  WidgetHudLayout,
} from '../../types/widget'
import { Toggle, FieldRow, Select } from '../ui'
import { Tooltip } from '../Tooltip'
import { useCanvasStore } from '../../store/canvasStore'
import { HudElementWrapper, ElementHudController } from './ElementHudController'
import type { WidgetDefinition } from '../../lib/widgetRegistry'

// ── Synced Lyrics Types & Parser ──
interface LyricLine {
  time: number
  text: string
}

function parseLrc(lrcText: string): LyricLine[] {
  if (!lrcText || !lrcText.trim()) return []
  const lines = lrcText.split('\n')
  const results: LyricLine[] = []

  // 1. Standard / Extended LRC: [mm:ss.xx] or [hh:mm:ss.xx]
  const lrcRegex = /\[(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/

  // 2. SRT / VTT timestamp: 00:01:23,450 --> 00:01:28,000 or 01:23.450 --> 01:28.000
  const srtRegex = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/

  // 3. YouTube Chapter / timestamp: 01:23 or 1:23:45 at start of line
  const chapterRegex = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]?.trim()
    if (!rawLine) continue

    // Check LRC format
    const lrcMatch = lrcRegex.exec(rawLine)
    if (lrcMatch) {
      const hours = lrcMatch[1] ? parseInt(lrcMatch[1], 10) : 0
      const mins = parseInt(lrcMatch[2]!, 10)
      const secs = parseInt(lrcMatch[3]!, 10)
      const millis = lrcMatch[4] ? parseFloat('0.' + lrcMatch[4]) : 0
      const time = hours * 3600 + mins * 60 + secs + millis
      const closeBracket = rawLine.lastIndexOf(']'); const text = (closeBracket !== -1 ? rawLine.slice(closeBracket + 1) : rawLine).trim()
      if (text.length > 0) results.push({ time, text })
      continue
    }

    // Check SRT / VTT format
    const srtMatch = srtRegex.exec(rawLine)
    if (srtMatch) {
      const hours = srtMatch[1] ? parseInt(srtMatch[1], 10) : 0
      const mins = parseInt(srtMatch[2]!, 10)
      const secs = parseInt(srtMatch[3]!, 10)
      const millis = srtMatch[4] ? parseFloat('0.' + srtMatch[4]) : 0
      const time = hours * 3600 + mins * 60 + secs + millis
      const nextLine = lines[i + 1]?.trim()
      if (nextLine && !nextLine.includes('-->') && isNaN(Number(nextLine))) {
        results.push({ time, text: nextLine })
        i++
      }
      continue
    }

    // Check YouTube Chapter / description format
    const chapMatch = chapterRegex.exec(rawLine)
    if (chapMatch) {
      const hours = chapMatch[1] ? parseInt(chapMatch[1], 10) : 0
      const mins = parseInt(chapMatch[2]!, 10)
      const secs = parseInt(chapMatch[3]!, 10)
      const timeStr = chapMatch[0]; const text = rawLine.slice(timeStr.length).replace(/^[\s–—-]+/, '').trim()
      if (text.length > 0) {
        results.push({ time: hours * 3600 + mins * 60 + secs, text })
      }
      continue
    }
  }

  return results.sort((a, b) => a.time - b.time)
}

// ── Cover Art Lookup & In-Memory Cache ──
const artCache = new Map<string, string>()

export async function fetchCoverArt(rawTitle: string, rawArtist?: string): Promise<string | null> {
  const { title, artist } = cleanTrackTitle(rawTitle, rawArtist)
  const cacheKey = `${title}|${artist}`.toLowerCase()
  if (artCache.has(cacheKey)) return artCache.get(cacheKey) || null

  const queries = [
    `${title} ${artist}`.trim(),
    title.trim(),
  ].filter((q) => q.length > 2)

  for (const q of queries) {
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`)
      if (res.ok) {
        const data = await res.json()
        if (data && data.resultCount > 0 && data.results?.[0]?.artworkUrl100) {
          const highRes = data.results[0].artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg')
          artCache.set(cacheKey, highRes)
          return highRes
        }
      }
    } catch {
      // Continue
    }
  }

  artCache.set(cacheKey, '')
  return null
}

// ── Intelligent Music & YouTube Title Cleaner ──
function cleanTrackTitle(rawTitle: string, rawArtist?: string): { title: string; artist: string; isLikelyPodcast: boolean } {
  let title = rawTitle || ''
  let artist = rawArtist || ''

  // Detect podcast indicators
  const isLikelyPodcast =
    /\b(podcast|episode|ep\.?\s*\d+|#\d{2,}|interview|talk|audiobook)\b/i.test(title) ||
    /\b(podcast|shows?)\b/i.test(artist)

  // Strip YouTube suffixes & metadata noise
  const pipeIdx = title.indexOf('|')
  if (pipeIdx !== -1) title = title.slice(0, pipeIdx).trim()
  let cleaned = ''
  let inBracket = false
  for (let c = 0; c < title.length; c++) {
    const ch = title[c]
    if (ch === '(' || ch === '[') inBracket = true
    else if (ch === ')' || ch === ']') inBracket = false
    else if (!inBracket) cleaned += ch
  }
  if (cleaned.trim().length > 0) title = cleaned.trim()

  // If title has "Artist - Track" and artist is empty or generic browser/YouTube
  if ((!artist || /chrome|edge|firefox|opera|browser|youtube/i.test(artist)) && title.includes(' - ')) {
    const parts = title.split(' - ')
    if (parts.length >= 2) {
      artist = parts[0]!.trim()
      title = parts.slice(1).join(' - ').trim()
    }
  }

  return { title, artist, isLikelyPodcast }
}

// ── Extract YouTube Video ID from URL, thumbnail, or string ──
export function extractYouTubeVideoId(input?: string): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed


  if (trimmed.includes('youtu.be/')) {
    const after = trimmed.split('youtu.be/')[1]?.split(/[?&#]/)[0]
    if (after && /^[a-zA-Z0-9_-]{11}$/.test(after)) return after
  }
  if (trimmed.includes('v=')) {
    const after = trimmed.split('v=')[1]?.split('&')[0]
    if (after && /^[a-zA-Z0-9_-]{11}$/.test(after)) return after
  }
  if (trimmed.includes('/embed/')) {
    const after = trimmed.split('/embed/')[1]?.split(/[?&#]/)[0]
    if (after && /^[a-zA-Z0-9_-]{11}$/.test(after)) return after
  }

  const mThumb = trimmed.match(/\/vi\/([a-zA-Z0-9_-]{11})\//)
  if (mThumb && mThumb[1]) return mThumb[1]

  return null
}

// ── Automated YouTube Caption / Subtitle Fetcher ──
export async function fetchYouTubeCaptions(videoId: string): Promise<LyricLine[]> {
  if (!videoId || videoId.length !== 11) return []

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 6000)

  try {
    // 1. Try Invidious API for WebVTT captions
    const invidiousInstances = [
      'https://inv.nadeko.net',
      'https://invidious.drgns.space',
      'https://yt.artemislena.eu',
      'https://invidious.nerdvpn.de',
    ]

    for (const host of invidiousInstances) {
      try {
        const res = await fetch(`${host}/api/v1/captions/${videoId}?label=English`, {
          signal: controller.signal,
        })
        if (res.ok) {
          const vttText = await res.text()
          if (vttText && vttText.includes('-->')) {
            clearTimeout(timeoutId)
            return parseLrc(vttText)
          }
        }
      } catch {
        // Try next instance
      }
    }

    // 2. Direct YouTube timedtext API fallback (fmt=json3)
    const timedTextUrls = [
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=json3`,
    ]

    for (const url of timedTextUrls) {
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (res.ok) {
          const data = await res.json()
          if (data && Array.isArray(data.events)) {
            const lines: LyricLine[] = []
            for (const ev of data.events) {
              if (ev.segs && ev.tStartMs != null) {
                const text = ev.segs.map((s: any) => s.utf8 || '').join('').replace(/\n/g, ' ').trim()
                if (text.length > 0) {
                  lines.push({
                    time: +(ev.tStartMs / 1000).toFixed(2),
                    text,
                  })
                }
              }
            }
            if (lines.length > 0) {
              clearTimeout(timeoutId)
              return lines.sort((a, b) => a.time - b.time)
            }
          }
        }
      } catch {
        // Continue
      }
    }
  } catch {
    // Ignore error
  } finally {
    clearTimeout(timeoutId)
  }

  return []
}

// ── Multi-Track Playlist for Browser Testing ──
interface PlaylistTrack {
  title: string
  artist: string
  source: string
  thumb: string
  duration: number
  lyrics: string
  bpm?: number
}

const MOCK_PLAYLIST: PlaylistTrack[] = [
  {
    title: 'Plastic Love',
    artist: 'Mariya Takeuchi',
    source: 'Spotify.exe',
    thumb: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500&q=80',
    duration: 218,
    bpm: 105,
    lyrics: `[00:00.00] With a sudden kiss or a plastic love
[00:05.00] Mayonaka no doa o tataki
[00:10.00] Kaeranaide to naita
[00:16.00] Ano kisetsu ga ima me no mae
[00:23.00] Stay with me, my darling
[00:30.00] Kuchiguse o nagara
[00:37.00] Futari no toki o daiteta
[00:44.00] Mada kiezu ni nokotteru
[00:52.00] I'm just playing games with memories
[01:03.00] Don't worry, it's just plastic love`,
  },
  {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    source: 'Spotify.exe',
    thumb: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=500&q=80',
    duration: 200,
    bpm: 171,
    lyrics: `[00:00.00] Yeah, I've been tryna call
[00:06.00] I've been on my own for long enough
[00:12.00] Maybe you can show me how to love
[00:18.00] I'm going through withdrawals
[00:24.00] You don't even have to do too much
[00:30.00] Sin City's cold and empty
[00:36.00] No one's around to judge me
[00:42.00] I can't see clearly when you're gone
[00:48.00] I said, ooh, I'm blinded by the lights`,
  },
  {
    title: 'Venom',
    artist: 'Eminem',
    source: 'Spotify.exe',
    thumb: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=500&q=80',
    duration: 269,
    bpm: 134,
    lyrics: `[00:00.00] I got a song filled with shit for the strong-willed
[00:06.00] When the world gives you a raw deal
[00:12.00] Sets you off 'til you scream 'piss off, screw you'
[00:18.00] When it talks to you like you don't belong
[00:24.00] Venom, adrenaline momentum
[00:30.00] And I'm not gonna slow up for 'em
[00:36.00] Ready to snap any moment-um
[00:42.00] Thinking it's time to go get 'em`,
  },
]

const SOURCE_NAMES: [RegExp, string][] = [
  [/spotify/i, 'Spotify'],
  [/chrome/i, 'Chrome'],
  [/msedge|edge/i, 'Edge'],
  [/firefox/i, 'Firefox'],
  [/vlc/i, 'VLC'],
  [/itunes|apple/i, 'Apple Music'],
  [/groove|zune/i, 'Groove'],
  [/foobar/i, 'foobar2000'],
]
function sourceName(id: string): string {
  if (!id) return ''
  for (const [re, name] of SOURCE_NAMES) if (re.test(id)) return name
  const tail = id.split('!').pop() || id
  return tail.replace(/\.exe$/i, '')
}

function useArtColor(thumb: string): string | null {
  const [rgb, setRgb] = useState<string | null>(null)
  useEffect(() => {
    if (!thumb) {
      setRgb(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const s = 24
      const c = document.createElement('canvas')
      c.width = s
      c.height = s
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      try {
        ctx.drawImage(img, 0, 0, s, s)
        const { data } = ctx.getImageData(0, 0, s, s)
        let r = 0, g = 0, b = 0, wsum = 0
        for (let i = 0; i < data.length; i += 4) {
          const R = data[i] ?? 0
          const G = data[i + 1] ?? 0
          const B = data[i + 2] ?? 0
          const mx = Math.max(R, G, B)
          const mn = Math.min(R, G, B)
          const sat = mx === 0 ? 0 : (mx - mn) / mx
          const lum = (mx + mn) / 2 / 255
          const w = sat * (1 - Math.abs(lum - 0.5) * 1.5)
          if (w > 0.05) {
            r += R * w
            g += G * w
            b += B * w
            wsum += w
          }
        }
        if (!cancelled) {
          setRgb(
            wsum > 0
              ? `rgb(${Math.round(r / wsum)}, ${Math.round(g / wsum)}, ${Math.round(b / wsum)})`
              : null,
          )
        }
      } catch {
        if (!cancelled) setRgb(null)
      }
    }
    img.onerror = () => {
      if (!cancelled) setRgb(null)
    }
    img.src = thumb
    return () => {
      cancelled = true
    }
  }, [thumb])
  return rgb
}

// ── Tactile Rotary & Arc Dial Math Helpers ──
function clockPoint(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return {
    x: cx + r * Math.sin(rad),
    y: cy - r * Math.cos(rad),
  }
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number) {
  if (sweepDeg <= 0) return ''
  const clampedSweep = Math.min(sweepDeg, 359.99)
  const endDeg = startDeg + clampedSweep
  const p1 = clockPoint(cx, cy, r, startDeg)
  const p2 = clockPoint(cx, cy, r, endDeg)
  const largeArc = clampedSweep > 180 ? 1 : 0
  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y}`
}

/**
 * Calculates volume (0.0 to 1.0) based on circular rotation around (cx, cy).
 * Clockwise rotation: 225° (min, bottom-left) -> 0° (top, 50%) -> 135° (max, bottom-right).
 * Bottom dead-zone (135° to 225°) smoothly clamps to 1.0 or 0.0 without jumping.
 */
function getVolumeFromRotation(cx: number, cy: number, clientX: number, clientY: number): number {
  const dx = clientX - cx
  const dy = clientY - cy
  if (Math.hypot(dx, dy) < 4) return -1 // center dead-zone

  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI
  if (deg < 0) deg += 360

  if (deg >= 225) {
    return (deg - 225) / 270
  } else if (deg <= 135) {
    return (deg + 135) / 270
  } else {
    return deg < 180 ? 1.0 : 0.0
  }
}

// ── 1. Tactile Rotary Dial Knob (True Circular Rotation Drag) ──
function VolumeKnob({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const { t } = useTranslation()
  const knobRef = useRef<HTMLDivElement>(null)
  const isRotating = useRef(false)
  const prevVal = useRef(value > 0 ? value : 0.7)

  // True circular rotation drag around knob center
  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const el = knobRef.current
    if (!el) return
    el.setPointerCapture(e.pointerId)
    isRotating.current = true

    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const next = getVolumeFromRotation(cx, cy, e.clientX, e.clientY)
    if (next >= 0) onChange(Math.round(next * 100) / 100)
    if (value > 0) prevVal.current = value
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isRotating.current) return
    e.stopPropagation()
    const el = knobRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const next = getVolumeFromRotation(cx, cy, e.clientX, e.clientY)
    if (next >= 0) onChange(Math.round(next * 100) / 100)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (isRotating.current) {
      isRotating.current = false
      try {
        knobRef.current?.releasePointerCapture(e.pointerId)
      } catch {}
    }
  }

  // Wheel scroll support
  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const step = e.deltaY < 0 ? 0.03 : -0.03
    onChange(Math.max(0, Math.min(1, Math.round((value + step) * 100) / 100)))
  }

  // Double click to mute / unmute
  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (value > 0) {
      prevVal.current = value
      onChange(0)
    } else {
      onChange(prevVal.current || 0.7)
    }
  }

  // 44px diameter knob
  const SIZE = 44
  const C = SIZE / 2
  const R = 16
  const START_DEG = 225
  const SWEEP_DEG = 270
  const curDeg = START_DEG + value * SWEEP_DEG
  const pInner = clockPoint(C, C, 6, curDeg)
  const pOuter = clockPoint(C, C, 14, curDeg)

  return (
    <div
      ref={knobRef}
      className="group relative flex items-center gap-2 select-none cursor-pointer"
      title={t('nowplaying.volume.knobTooltip', 'Rotate mouse around dial or scroll wheel to adjust, double-click to mute')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} className="overflow-visible">
          {/* Outer tick marks */}
          {Array.from({ length: 9 }).map((_, i) => {
            const tickDeg = START_DEG + (i / 8) * SWEEP_DEG
            const t1 = clockPoint(C, C, 18, tickDeg)
            const t2 = clockPoint(C, C, 21, tickDeg)
            const isTickActive = i / 8 <= value + 0.01
            return (
              <line
                key={i}
                x1={t1.x}
                y1={t1.y}
                x2={t2.x}
                y2={t2.y}
                stroke={isTickActive ? 'var(--accent)' : 'rgba(255,255,255,0.18)'}
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            )
          })}

          {/* Background Track Arc */}
          <path
            d={describeArc(C, C, R, START_DEG, SWEEP_DEG)}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={3}
            strokeLinecap="round"
          />

          {/* Active Glowing Arc */}
          {value > 0.01 && (
            <path
              d={describeArc(C, C, R, START_DEG, value * SWEEP_DEG)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={3}
              strokeLinecap="round"
              style={{ filter: 'drop-shadow(0 0 4px var(--accent))' }}
            />
          )}

          {/* Dial Center Body */}
          <circle
            cx={C}
            cy={C}
            r={13}
            fill="#18181c"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth={1}
            className="group-hover:stroke-white/50 transition-colors shadow-lg"
          />

          {/* Indicator Needle */}
          <line
            x1={pInner.x}
            y1={pInner.y}
            x2={pOuter.x}
            y2={pOuter.y}
            stroke={value === 0 ? 'rgba(255,255,255,0.3)' : 'var(--accent)'}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* Percentage Readout */}
      <div className="flex flex-col text-left">
        <span className="font-mono text-[11px] font-bold text-white tabular-nums tracking-tight leading-none">
          {Math.round(value * 100)}%
        </span>
        <span className="text-[8px] uppercase font-semibold text-[var(--text-tertiary)] tracking-wider mt-0.5">
          {value === 0 ? 'Mute' : 'Vol'}
        </span>
      </div>
    </div>
  )
}

// ── 2. Studio Hi-Fi Fader ──
function VolumeFader({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const prevVal = useRef(value > 0 ? value : 0.7)

  const updateFromPointer = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const next = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onChange(Math.round(next * 100) / 100)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    isDragging.current = true
    updateFromPointer(e.clientX)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return
    e.stopPropagation()
    updateFromPointer(e.clientX)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (isDragging.current) {
      isDragging.current = false
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {}
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const step = e.deltaY < 0 ? 0.03 : -0.03
    onChange(Math.max(0, Math.min(1, Math.round((value + step) * 100) / 100)))
  }

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (value > 0) {
      prevVal.current = value
      onChange(0)
    } else {
      onChange(prevVal.current || 0.7)
    }
  }

  return (
    <div
      className="flex min-w-[110px] max-w-[160px] flex-1 items-center gap-2 select-none"
      onClick={(e) => e.stopPropagation()}
      onWheel={onWheel}
    >
      <button
        type="button"
        onClick={toggleMute}
        title={value === 0 ? 'Unmute' : 'Mute'}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-white transition-colors"
      >
        {value === 0 ? <VolumeX size={13} className="text-rose-400" /> : <Volume2 size={13} />}
      </button>

      {/* Console Fader Track */}
      <div
        ref={trackRef}
        className="relative flex-1 h-7 flex items-center cursor-ew-resize py-1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Recessed slot with graduation marks */}
        <div className="relative w-full h-2 rounded bg-black/40 border border-white/10 shadow-inner flex items-center px-0.5">
          {/* Subtle center line */}
          <div className="absolute inset-x-1 top-1/2 h-[1px] bg-white/10 -translate-y-1/2" />
          
          {/* Active fill */}
          <div
            className="h-1 rounded-sm bg-[var(--accent)] opacity-80"
            style={{ width: `${value * 100}%` }}
          />
        </div>

        {/* Studio Metallic Fader Cap */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-6 rounded-[3px] bg-gradient-to-b from-[#3a3a42] via-[#24242a] to-[#141418] border border-white/30 shadow-[0_2px_6px_rgba(0,0,0,0.6)] flex items-center justify-center pointer-events-none transition-transform hover:scale-105"
          style={{ left: `${value * 100}%` }}
        >
          {/* Center line notch on fader cap */}
          <div className="w-[1.5px] h-3.5 bg-white/90 rounded-full" />
        </div>
      </div>

      <span className="shrink-0 text-right font-mono text-[9.5px] text-[var(--text-tertiary)] tabular-nums min-w-[30px]">
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

// ── 3. Segmented LED Ladder ──
function VolumeStepped({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const TOTAL_STEPS = 10
  const activeSteps = Math.round(value * TOTAL_STEPS)
  const prevVal = useRef(value > 0 ? value : 0.7)

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (value > 0) {
      prevVal.current = value
      onChange(0)
    } else {
      onChange(prevVal.current || 0.7)
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const step = e.deltaY < 0 ? 1 / TOTAL_STEPS : -1 / TOTAL_STEPS
    onChange(Math.max(0, Math.min(1, Math.round((value + step) * TOTAL_STEPS) / TOTAL_STEPS)))
  }

  return (
    <div
      className="flex min-w-[110px] max-w-[160px] flex-1 items-center gap-1.5 select-none"
      onClick={(e) => e.stopPropagation()}
      onWheel={onWheel}
    >
      <button
        type="button"
        onClick={toggleMute}
        title={value === 0 ? 'Unmute' : 'Mute'}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-white transition-colors"
      >
        {value === 0 ? <VolumeX size={13} className="text-rose-400" /> : <Volume2 size={13} />}
      </button>

      {/* Discrete Segmented LED Blocks */}
      <div className="flex flex-1 items-center gap-[3px] py-1">
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => {
          const isActive = i < activeSteps
          let colorClass = 'bg-emerald-400'
          let glowColor = 'rgba(52, 211, 153, 0.6)'
          if (i >= 8) {
            colorClass = 'bg-rose-500'
            glowColor = 'rgba(244, 63, 94, 0.7)'
          } else if (i >= 6) {
            colorClass = 'bg-amber-400'
            glowColor = 'rgba(251, 191, 36, 0.6)'
          }

          return (
            <button
              key={i}
              type="button"
              onClick={() => onChange((i + 1) / TOTAL_STEPS)}
              className={`h-4 flex-1 rounded-[1.5px] transition-all cursor-pointer ${
                isActive
                  ? `${colorClass} opacity-95 scale-y-100`
                  : 'bg-white/10 opacity-30 scale-y-75 hover:bg-white/20'
              }`}
              style={{
                boxShadow: isActive ? `0 0 5px ${glowColor}` : 'none',
              }}
              title={`${Math.round(((i + 1) / TOTAL_STEPS) * 100)}%`}
            />
          )
        })}
      </div>

      <span className="shrink-0 text-right font-mono text-[9.5px] text-[var(--text-tertiary)] tabular-nums min-w-[26px]">
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

// ── 4. Circular Arc Gauge (Smart Neon Halo Ring with Circular Drag) ──
function VolumeArc({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const arcRef = useRef<HTMLDivElement>(null)
  const isRotating = useRef(false)
  const prevVal = useRef(value > 0 ? value : 0.7)

  const SIZE = 36
  const C = SIZE / 2
  const R = 14
  const START_DEG = 225
  const SWEEP_DEG = 270
  const curDeg = START_DEG + value * SWEEP_DEG
  const tipPoint = clockPoint(C, C, R, curDeg)

  const toggleMute = () => {
    if (value > 0) {
      prevVal.current = value
      onChange(0)
    } else {
      onChange(prevVal.current || 0.7)
    }
  }

  // True circular rotation drag around center
  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const el = arcRef.current
    if (!el) return
    el.setPointerCapture(e.pointerId)
    isRotating.current = true

    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy)

    // Center click toggles mute
    if (dist < 8) {
      toggleMute()
      return
    }

    const next = getVolumeFromRotation(cx, cy, e.clientX, e.clientY)
    if (next >= 0) onChange(Math.round(next * 100) / 100)
    if (value > 0) prevVal.current = value
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isRotating.current) return
    e.stopPropagation()
    const el = arcRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const next = getVolumeFromRotation(cx, cy, e.clientX, e.clientY)
    if (next >= 0) onChange(Math.round(next * 100) / 100)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (isRotating.current) {
      isRotating.current = false
      try {
        arcRef.current?.releasePointerCapture(e.pointerId)
      } catch {}
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const step = e.deltaY < 0 ? 0.03 : -0.03
    onChange(Math.max(0, Math.min(1, Math.round((value + step) * 100) / 100)))
  }

  return (
    <div
      className="group relative flex items-center gap-2 select-none"
      onClick={(e) => e.stopPropagation()}
      onWheel={onWheel}
    >
      <div
        ref={arcRef}
        className="relative cursor-pointer shrink-0"
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title={`Volume: ${Math.round(value * 100)}% (Rotate around ring or wheel to adjust, click center to mute)`}
      >
        <svg width={SIZE} height={SIZE} className="overflow-visible">
          {/* Subtle Outer Halo Track */}
          <path
            d={describeArc(C, C, R, START_DEG, SWEEP_DEG)}
            fill="none"
            stroke="rgba(255,255,255,0.14)"
            strokeWidth={2.5}
            strokeLinecap="round"
          />

          {/* Active Glowing Neon Halo */}
          {value > 0.01 && (
            <path
              d={describeArc(C, C, R, START_DEG, value * SWEEP_DEG)}
              fill="none"
              stroke={value === 0 ? 'rgba(255,255,255,0.3)' : 'var(--accent)'}
              strokeWidth={2.5}
              strokeLinecap="round"
              style={{ filter: 'drop-shadow(0 0 4px var(--accent))' }}
            />
          )}

          {/* Glowing Arc Tip Bead */}
          {value > 0.02 && (
            <circle
              cx={tipPoint.x}
              cy={tipPoint.y}
              r={2.5}
              fill="white"
              style={{ filter: 'drop-shadow(0 0 3px var(--accent))' }}
            />
          )}
        </svg>

        {/* Center Speaker Icon (Clickable for mute) */}
        <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)] group-hover:text-white transition-colors pointer-events-none">
          {value === 0 ? (
            <VolumeX size={12} className="text-rose-400" />
          ) : value < 0.5 ? (
            <Volume1 size={12} />
          ) : (
            <Volume2 size={12} />
          )}
        </div>
      </div>

      <span className="font-mono text-[10px] font-semibold text-[var(--text-tertiary)] tabular-nums group-hover:text-white transition-colors">
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

// ── 5. Minimalist Number Pill ──
function VolumePill({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const pillRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const prevVal = useRef(value > 0 ? value : 0.7)

  const updateFromPointer = (clientX: number) => {
    const el = pillRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const next = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onChange(Math.round(next * 100) / 100)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    isDragging.current = true
    updateFromPointer(e.clientX)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return
    e.stopPropagation()
    updateFromPointer(e.clientX)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (isDragging.current) {
      isDragging.current = false
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {}
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const step = e.deltaY < 0 ? 0.03 : -0.03
    onChange(Math.max(0, Math.min(1, Math.round((value + step) * 100) / 100)))
  }

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (value > 0) {
      prevVal.current = value
      onChange(0)
    } else {
      onChange(prevVal.current || 0.7)
    }
  }

  return (
    <div
      ref={pillRef}
      className="group relative flex h-6 min-w-[74px] items-center justify-between rounded-full bg-white/10 px-2.5 border border-white/15 select-none cursor-ew-resize overflow-hidden hover:border-white/30 transition-all"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      title={`Volume: ${Math.round(value * 100)}% (Drag or scroll wheel to adjust, click icon to mute)`}
    >
      {/* Liquid background fill */}
      <div
        className="absolute inset-y-0 left-0 bg-[var(--accent)] opacity-25 pointer-events-none transition-all duration-75"
        style={{ width: `${value * 100}%` }}
      />

      {/* Foreground Speaker and Percent */}
      <button
        type="button"
        onClick={toggleMute}
        className="relative z-10 text-[var(--text-secondary)] group-hover:text-white transition-colors"
      >
        {value === 0 ? <VolumeX size={12} className="text-rose-400" /> : <Volume2 size={12} />}
      </button>

      <span className="relative z-10 font-mono text-[10px] font-bold text-white tabular-nums tracking-tight">
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

// ── 6. Hover Speaker Icon ──
function VolumeHover({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [isHovered, setIsHovered] = useState(false)
  const prevVal = useRef(value > 0 ? value : 0.7)

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (value > 0) {
      prevVal.current = value
      onChange(0)
    } else {
      onChange(prevVal.current || 0.7)
    }
  }

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        type="button"
        onClick={toggleMute}
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:text-white hover:bg-white/10 transition-colors"
      >
        {value === 0 ? <VolumeX size={15} className="text-rose-400" /> : <Volume2 size={15} />}
      </button>
      <div
        className={`flex items-center gap-1.5 overflow-hidden transition-all duration-200 ${
          isHovered ? 'w-24 opacity-100 ml-1.5' : 'w-0 opacity-0 pointer-events-none'
        }`}
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[var(--surface-active)] accent-[var(--accent)]"
        />
      </div>
    </div>
  )
}

// ── 7. Horizontal Slider Bar ──
function VolumeBar({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const prevVal = useRef(value > 0 ? value : 0.7)

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (value > 0) {
      prevVal.current = value
      onChange(0)
    } else {
      onChange(prevVal.current || 0.7)
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const step = e.deltaY < 0 ? 0.03 : -0.03
    onChange(Math.max(0, Math.min(1, Math.round((value + step) * 100) / 100)))
  }

  return (
    <div
      className="flex min-w-[70px] flex-1 items-center gap-2 select-none"
      onClick={(e) => e.stopPropagation()}
      onWheel={onWheel}
    >
      <button
        type="button"
        onClick={toggleMute}
        title={value === 0 ? 'Unmute' : 'Mute'}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-white transition-colors"
      >
        {value === 0 ? <VolumeX size={13} className="text-rose-400" /> : <Volume2 size={13} />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 min-w-[40px] flex-1 cursor-pointer appearance-none rounded-full bg-[var(--surface-active)] accent-[var(--accent)]"
      />
      <span className="shrink-0 text-right font-mono text-[10px] text-[var(--text-tertiary)] tabular-nums min-w-[28px]">
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

// ── Unified Volume Controller ──
function VolumeControl({
  style = 'bar',
  value,
  onChange,
}: {
  style: VolumeStyle
  value: number
  onChange: (v: number) => void
}) {
  if (style === 'hidden') return <div className="flex-1" />
  if (style === 'knob') return <VolumeKnob value={value} onChange={onChange} />
  if (style === 'fader') return <VolumeFader value={value} onChange={onChange} />
  if (style === 'stepped') return <VolumeStepped value={value} onChange={onChange} />
  if (style === 'arc') return <VolumeArc value={value} onChange={onChange} />
  if (style === 'pill') return <VolumePill value={value} onChange={onChange} />
  if (style === 'bar') return <VolumeBar value={value} onChange={onChange} />
  return <div className="flex-1" />
}

// ── Card Info Detail Renderer (Alignment, Typography & Density) ──
function TrackInfo({
  title,
  artist,
  source,
  alignment = 'left',
  typography = 'modern',
  density = 'stacked',
  showArtist = true,
  marquee = false,
  titleSize = 15,
  artistSize = 12.5,
  lyricsStyle = 'off',
  activeLyric,
  nextLyric,
  artRgb,
  wallpaperAccent,
  hudLayout,
  hudEditMode,
  selectedElement,
  onHudSelect,
  onHudMove,
}: {
  title: string
  artist: string
  source?: string
  alignment?: InfoAlignment
  typography?: InfoTypography
  density?: InfoDensity
  showArtist?: boolean
  marquee?: boolean
  titleSize?: number
  artistSize?: number
  lyricsStyle?: LyricsStyle
  activeLyric?: { text: string }
  nextLyric?: { text: string }
  artRgb?: string | null
  wallpaperAccent?: string | null
  hudLayout?: WidgetHudLayout
  hudEditMode?: boolean
  selectedElement?: WidgetElementKey
  onHudSelect?: (key: WidgetElementKey) => void
  onHudMove?: (key: WidgetElementKey, x: number, y: number) => void
}) {
  if (density === 'hidden') return null

  const alignClass =
    alignment === 'center'
      ? 'items-center text-center'
      : alignment === 'right'
      ? 'items-end text-right'
      : 'items-start text-left'

  let typoFont = 'font-sans font-bold tracking-tight'
  if (typography === 'mono') typoFont = 'font-mono font-semibold tracking-tight'
  else if (typography === 'serif') typoFont = 'font-serif font-bold italic tracking-wide'
  else if (typography === 'allcaps') typoFont = 'font-sans font-extrabold uppercase tracking-[0.08em]'

  return (
    <div className={`flex min-w-0 w-full flex-col ${alignClass} gap-0.5 overflow-hidden`}>
      {density === 'inline' ? (
        /* Single Inline Row: Title • Artist */
        <div className="w-full overflow-hidden truncate">
          <span
            className={`font-bold text-[var(--text-primary)] ${typoFont} ${marquee ? 'animate-marquee-text' : 'truncate'}`}
            style={{ fontSize: `${titleSize}px` }}
          >
            {title}
          </span>
          {showArtist && artist && (
            <span
              className="text-[var(--text-secondary)] font-medium ml-1.5 opacity-80"
              style={{ fontSize: `${artistSize}px` }}
            >
              • {artist}
            </span>
          )}
        </div>
      ) : density === 'badges' ? (
        /* Badges Density: Title + Pill Badge with Source & Artist */
        <>
          <div className="w-full overflow-hidden">
            <span
              className={`font-bold text-[var(--text-primary)] ${typoFont} ${marquee ? 'animate-marquee-text' : 'block truncate'}`}
              style={{
                fontSize: `${titleSize}px`,
                letterSpacing: typography === 'allcaps' ? '0.08em' : '-0.4px',
              }}
            >
              {title}
            </span>
          </div>
          <div className={`flex items-center gap-1.5 flex-wrap mt-0.5 ${alignment === 'center' ? 'justify-center' : alignment === 'right' ? 'justify-end' : ''}`}>
            {source && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold tracking-wider uppercase bg-white/10 text-[var(--accent)] border border-white/10 shrink-0">
                <Music size={9} />
                {sourceName(source)}
              </span>
            )}
            {showArtist && artist && (
              <span
                className="truncate font-medium text-[var(--text-secondary)]"
                style={{ fontSize: `${artistSize}px` }}
              >
                {artist}
              </span>
            )}
          </div>
        </>
      ) : (
        /* Classic Stacked: Row 1 Title, Row 2 Artist */
        <>
          <div className="w-full overflow-hidden">
            <span
              className={`font-bold text-[var(--text-primary)] ${typoFont} ${marquee ? 'animate-marquee-text' : 'block truncate'}`}
              style={{
                fontSize: `${titleSize}px`,
                letterSpacing: typography === 'allcaps' ? '0.08em' : '-0.4px',
              }}
            >
              {title}
            </span>
          </div>
          {showArtist && (
            <span
              className="truncate w-full font-medium text-[var(--text-secondary)]"
              style={{ fontSize: `${artistSize}px` }}
            >
              {artist || '—'}
            </span>
          )}
        </>
      )}

      {/* Synced Lyrics Preview */}
      {lyricsStyle !== 'off' && activeLyric && (
        <HudElementWrapper
          elementKey="lyrics"
          label="Lyrics"
          hudLayout={hudLayout}
          hudEditMode={hudEditMode}
          selectedElement={selectedElement}
          onSelect={onHudSelect}
          onMove={onHudMove}
          className={`mt-0.5 flex flex-col text-[10.5px] leading-tight w-full ${alignClass}`}
        >
          <span style={getLyricsStyle(lyricsStyle, true, artRgb, wallpaperAccent)} className="truncate italic">
            ♪ {activeLyric.text}
          </span>
          {nextLyric && (
            <span className="truncate text-white/40 italic text-[9.5px]">
              ♪ {nextLyric.text}
            </span>
          )}
        </HudElementWrapper>
      )}
    </div>
  )
}

// ── Track Beat Phase Offset Calibration (Downbeat alignment in seconds) ──
function getTrackBeatOffset(title?: string, artist?: string): number {
  if (!title) return 0
  const lower = (title + ' ' + (artist || '')).toLowerCase()
  if (lower.includes('plastic love')) return 0.82
  if (lower.includes('blinding lights')) return 0.22
  if (lower.includes('venom')) return 0.35
  if (lower.includes('stay with me')) return 0.72
  return 0
}

// ── Bass Halo (Trap Nation Subwoofer Speaker & 360° Radial Beat Rays) ──
function SubwooferHaloArtwork({
  thumb,
  title,
  size,
  isHero = false,
  playing = false,
  trackBpm = 120,
  visualizerColor = '#ef4444',
  playbackPos = 0,
  beatOffset = 0,
  onTapBeatSync,
  liveAudioPeakRef,
}: {
  thumb: string
  title: string
  size?: number | string
  isHero?: boolean
  playing?: boolean
  trackBpm?: number
  visualizerColor?: string
  playbackPos?: number
  beatOffset?: number
  onTapBeatSync?: () => void
  liveAudioPeakRef?: React.MutableRefObject<number>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coneRef = useRef<HTMLDivElement>(null)
  const posRef = useRef(playbackPos)
  posRef.current = playbackPos
  const offsetRef = useRef(beatOffset)
  offsetRef.current = beatOffset
  const bpmRef = useRef(trackBpm)
  bpmRef.current = trackBpm

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let lastTime = performance.now()
    let localPos = posRef.current
    let prevBeatInt = -1

    const RAY_COUNT = 60
    const smoothRays = new Array(RAY_COUNT).fill(0)
    const shockwaves: { radius: number; alpha: number }[] = []

    const render = (time: number) => {
      const dt = Math.min(0.05, (time - lastTime) / 1000)
      lastTime = time

      if (playing) {
        localPos += dt
        const diff = posRef.current - localPos
        if (Math.abs(diff) > 0.35) {
          localPos = posRef.current
        } else {
          localPos += diff * 0.15
        }
      } else {
        localPos = posRef.current
      }

      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (w === 0 || h === 0) {
        raf = requestAnimationFrame(render)
        return
      }

      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr)
        canvas.height = Math.floor(h * dpr)
      }

      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      const cx = w / 2
      const cy = h / 2
      const baseColor = getSafeCanvasColor(visualizerColor)
      const bpm = bpmRef.current || 120
      const beatSec = 60 / bpm
      const totalOffset = offsetRef.current || 0
      const beatProgress = (localPos - totalOffset) / beatSec
      const beatPhase = (beatProgress % 1.0 + 1.0) % 1.0
      const currentBeatInt = Math.floor(beatProgress)

      // Real-time hardware audio peak reactivity (or beat fallback)
      const livePeak = liveAudioPeakRef?.current || 0
      const isLiveHardware = livePeak > 0.005
      const kick = isLiveHardware
        ? Math.min(1.0, Math.pow(livePeak * 1.35, 1.45))
        : (playing ? Math.pow(Math.max(0, 1 - beatPhase * 3.4), 2.2) : 0)
      const snarePhase = ((beatPhase + 0.5) % 1.0 + 1.0) % 1.0
      const snare = playing ? Math.pow(Math.max(0, 1 - snarePhase * 3.2), 2.0) : 0
      const hatPhase = ((beatProgress * 4) % 1.0 + 1.0) % 1.0
      const hat = playing ? Math.pow(Math.max(0, 1 - hatPhase * 3.8), 1.8) : 0
      const rayEnergy = isLiveHardware ? Math.min(1.0, livePeak * 1.6) : (playing ? 0.35 + kick * 0.65 : 0)

      // Dynamically pump subwoofer cone excursion in lockstep with the kick
      if (coneRef.current) {
        const coneScale = playing ? 1.0 + kick * 0.11 : 1.0
        coneRef.current.style.transform = `scale(${coneScale.toFixed(4)})`
      }

      // Trigger shockwave ring on new beat downbeat
      if (playing && currentBeatInt !== prevBeatInt) {
        prevBeatInt = currentBeatInt
        shockwaves.push({ radius: Math.min(w, h) * 0.28, alpha: 0.95 })
        if (shockwaves.length > 6) shockwaves.shift()
      }

      const minDim = Math.min(w, h)
      // Radius of the speaker rubber surround rim
      const rInner = minDim * 0.29 * (1.0 + kick * 0.08)
      const maxRayLen = minDim * 0.19

      // Expanding shockwave rings on downbeats
      for (let i = shockwaves.length - 1; i >= 0; i--) {
        const ring = shockwaves[i]
        if (!ring) continue
        ring.radius += dt * minDim * 0.85
        ring.alpha *= 0.92

        if (ring.alpha <= 0.03 || ring.radius > minDim * 0.52) {
          shockwaves.splice(i, 1)
          continue
        }

        ctx.beginPath()
        ctx.arc(cx, cy, ring.radius, 0, Math.PI * 2)
        ctx.strokeStyle = baseColor
        ctx.globalAlpha = ring.alpha
        ctx.lineWidth = 1.8
        ctx.stroke()
        ctx.globalAlpha = 1.0
      }

      // Draw 360° Radial Equalizer Spectrum Bars
      for (let i = 0; i < RAY_COUNT; i++) {
        const norm = i / RAY_COUNT
        const angle = norm * Math.PI * 2 - Math.PI / 2

        // Symmetrical audio distribution: bass at top/bottom, mids & treble around sides
        const distFromPole = Math.abs(Math.sin(angle))
        const bassPart = (1 - distFromPole) * (kick * 0.92 + 0.1)
        const midPart = distFromPole * (snare * 0.78 + 0.14)
        const treblePart = Math.pow(distFromPole, 1.8) * (hat * 0.65 + 0.08)
        const harm = Math.sin(localPos * 7.2 + i * 0.6) * 0.1

        const targetAmp = (playing || isLiveHardware) ? Math.min(1.0, Math.max(0.06, (bassPart + midPart + treblePart + harm) * (isLiveHardware ? rayEnergy : 1))) : 0.04
        const targetLen = Math.max(2.5, targetAmp * maxRayLen)

        const cur = smoothRays[i] || 0
        if (targetLen > cur) {
          smoothRays[i] = cur + (targetLen - cur) * 0.8
        } else {
          smoothRays[i] = cur * (playing ? 0.83 : 0.7)
        }

        const barLen = smoothRays[i] || 2.5
        const x1 = cx + Math.cos(angle) * (rInner + 1)
        const y1 = cy + Math.sin(angle) * (rInner + 1)
        const x2 = cx + Math.cos(angle) * (rInner + 1 + barLen)
        const y2 = cy + Math.sin(angle) * (rInner + 1 + barLen)

        const rayGrad = ctx.createLinearGradient(x1, y1, x2, y2)
        safeAddColorStop(rayGrad, 0, baseColor, '#ef4444')
        safeAddColorStop(rayGrad, 0.75, baseColor, '#ef4444')
        safeAddColorStop(rayGrad, 1, '#ffffff', '#ffffff')

        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.strokeStyle = rayGrad
        ctx.lineWidth = Math.max(1.8, Math.min(3.6, minDim * 0.024))
        ctx.lineCap = 'round'
        ctx.shadowColor = baseColor
        ctx.shadowBlur = playing ? (8 + kick * 8) : 2
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      ctx.restore()
      if (playing) {
        raf = requestAnimationFrame(render)
      }
    }

    if (playing) {
      raf = requestAnimationFrame(render)
    }
    return () => cancelAnimationFrame(raf)
  }, [playing, visualizerColor])

  return (
    <div
      onClick={onTapBeatSync}
      title={onTapBeatSync ? 'Tap to Sync Beat Downbeat' : undefined}
      className={`relative shrink-0 flex items-center justify-center select-none bg-transparent aspect-square cursor-pointer ${
        isHero ? 'h-full max-h-full max-w-full aspect-square' : ''
      }`}
      style={!isHero && size ? { width: size, height: size } : undefined}
    >
      {/* 360° Radiating Halo Spectrum Canvas (Z-0) */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-0" />

      {/* Center Subwoofer Speaker Cone with Album Art (Z-10) */}
      <div
        ref={coneRef}
        className="relative flex items-center justify-center rounded-full select-none z-10 transition-transform duration-75 will-change-transform"
        style={{ width: '58%', height: '58%' }}
      >
        {/* Rubber Surround Beveled Roll */}
        <div
          className="relative w-full h-full rounded-full shadow-2xl flex items-center justify-center p-[6%]"
          style={{
            background: 'radial-gradient(circle, #2a2b30 0%, #15161a 65%, #09090b 100%)',
            boxShadow:
              '0 8px 26px rgba(0,0,0,0.85), inset 0 2px 4px rgba(255,255,255,0.25), inset 0 -3px 6px rgba(0,0,0,0.95)',
          }}
        >
          {/* Inner Speaker Cone with Album Artwork */}
          <div className="relative w-full h-full rounded-full overflow-hidden shadow-inner ring-1 ring-white/20">
            {thumb ? (
              <img
                src={thumb}
                alt={title}
                className="w-full h-full rounded-full object-cover select-none pointer-events-none"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-zinc-800 to-zinc-950 flex items-center justify-center">
                <Music className="h-1/3 w-1/3 text-white/40" />
              </div>
            )}
            {/* Cone depth gloss & lighting */}
            <div
              className="absolute inset-0 rounded-full pointer-events-none opacity-30 mix-blend-overlay"
              style={{
                background:
                  'radial-gradient(circle at 35% 35%, rgba(255,255,255,0.6) 0%, transparent 60%, rgba(0,0,0,0.8) 100%)',
              }}
            />
          </div>

          {/* Subwoofer Concave Center Dust Cap */}
          <div
            className="absolute w-[34%] h-[34%] rounded-full shadow-md pointer-events-none"
            style={{
              background:
                'radial-gradient(circle at 35% 35%, rgba(255,255,255,0.2) 0%, rgba(24,24,27,0.85) 55%, rgba(0,0,0,0.98) 100%)',
              boxShadow: '0 2px 6px rgba(0,0,0,0.9), inset 0 1px 2px rgba(255,255,255,0.25)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ── Album Artwork Renderer (Square, Circle, Spinning Vinyl / CD) ──
function ArtworkRenderer({
  thumb,
  title,
  design = 'square',
  size,
  isHero = false,
  adaptiveRatio = false,
  playing = false,
  visualizerType,
  visualizerColor,
  trackBpm = 120,
  playbackPos = 0,
  beatOffset = 0,
  onTapBeatSync,
  liveAudioPeakRef,
}: {
  thumb: string
  title: string
  design?: ArtDesign
  size?: number | string
  isHero?: boolean
  adaptiveRatio?: boolean
  playing?: boolean
  visualizerType?: VisualizerType
  visualizerColor?: string
  trackBpm?: number
  playbackPos?: number
  beatOffset?: number
  onTapBeatSync?: () => void
  liveAudioPeakRef?: React.MutableRefObject<number>
}) {
  // When Beat Visualizer is 'halo', the artwork becomes the iconic Trap Nation Subwoofer Bass Halo!
  if (visualizerType === 'halo') {
    return (
      <SubwooferHaloArtwork
        thumb={thumb}
        title={title}
        size={size}
        isHero={isHero}
        playing={playing}
        trackBpm={trackBpm}
        visualizerColor={visualizerColor}
        playbackPos={playbackPos}
        beatOffset={beatOffset}
        onTapBeatSync={onTapBeatSync}
        liveAudioPeakRef={liveAudioPeakRef}
      />
    )
  }

  const isPulse = visualizerType === 'pulse' && playing
  const bounceAnimation = isPulse ? `beatThumbBounce ${(60 / trackBpm).toFixed(3)}s ease-out infinite` : 'none'
  const pulseRingAnimation = isPulse ? `beatRingPulse ${(60 / trackBpm).toFixed(3)}s ease-out infinite` : 'none'

  // 2D Vintage Vinyl Turntable with Pivoting Tonearm (Directly Above CD, 100% Clean Fit)
  if (design === 'turntable') {
    return (
      <div
        className={`relative shrink-0 flex items-center justify-center select-none bg-transparent aspect-square ${
          isHero ? 'h-full max-h-full max-w-full aspect-square' : ''
        }`}
        style={!isHero && size ? { width: size, height: size } : undefined}
      >
        {/* 2D Circular Vinyl Record (Z-10, Clean Aspect-Square, Centered) */}
        <div className="relative w-[94%] h-[94%] flex items-center justify-center">
          {isPulse && (
            <div
              className="absolute -inset-1.5 rounded-full pointer-events-none"
              style={{
                border: `2px solid ${visualizerColor}`,
                animation: pulseRingAnimation,
                boxShadow: `0 0 16px ${visualizerColor}`,
              }}
            />
          )}

          {/* Platter drop shadow */}
          <div
            className="relative w-full h-full rounded-full shadow-2xl flex items-center justify-center"
            style={{
              boxShadow: '0 8px 24px rgba(0,0,0,0.7), 0 2px 6px rgba(0,0,0,0.4)',
            }}
          >
            {/* Spinning Obsidian Black Vinyl Disc */}
            <div
              className="relative w-full h-full rounded-full flex items-center justify-center overflow-hidden"
              style={{
                background: 'radial-gradient(circle, #24252a 0%, #15161a 45%, #0c0d10 72%, #040405 100%)',
                animation: 'spinDisc 4.5s linear infinite',
                animationPlayState: playing ? 'running' : 'paused',
                boxShadow: 'inset 0 0 3px rgba(255,255,255,0.25)',
              }}
            >
              {/* Concentric sound micro-grooves */}
              <div className="absolute inset-[8%] rounded-full border border-white/[0.06] pointer-events-none" />
              <div className="absolute inset-[15%] rounded-full border border-white/[0.04] pointer-events-none" />
              <div className="absolute inset-[22%] rounded-full border border-white/[0.06] pointer-events-none" />
              <div className="absolute inset-[29%] rounded-full border border-white/[0.04] pointer-events-none" />
              <div className="absolute inset-[36%] rounded-full border border-white/[0.06] pointer-events-none" />

              {/* Dual vinyl sheen reflections */}
              <div
                className="absolute inset-0 rounded-full pointer-events-none opacity-30 mix-blend-screen"
                style={{
                  background:
                    'conic-gradient(from 45deg, rgba(255,255,255,0.35) 0deg, transparent 40deg, transparent 140deg, rgba(255,255,255,0.35) 180deg, transparent 220deg, transparent 320deg, rgba(255,255,255,0.35) 360deg)',
                }}
              />

              {/* Center Circular Album Artwork Label */}
              <div className="relative w-[48%] h-[48%] rounded-full overflow-hidden shadow-inner ring-1 ring-black/80 flex items-center justify-center bg-zinc-900">
                {thumb ? (
                  <img
                    src={thumb}
                    alt={title}
                    className="w-full h-full object-cover select-none pointer-events-none"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-neutral-800 to-neutral-900 flex items-center justify-center text-[10px] text-white/70 font-bold">
                    LP
                  </div>
                )}
                {/* Vinyl label print rings */}
                <div className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/20 pointer-events-none" />
                <div className="absolute inset-[12%] rounded-full border border-black/30 pointer-events-none" />
              </div>

              {/* Center Silver Spindle Pin */}
              <div
                className="absolute w-[10%] h-[10%] rounded-full shadow-md z-10 pointer-events-none"
                style={{
                  background: 'radial-gradient(circle at 35% 35%, #ffffff 0%, #cbd5e1 45%, #475569 85%, #0f172a 100%)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.8), inset 0 1px 1px #fff',
                }}
              />
            </div>
          </div>
        </div>

        {/* 2D Precision Scalable Tonearm (Z-20, Mounted DIRECTLY ABOVE the CD, Zero Outside Spill) */}
        <div className="absolute inset-0 w-full h-full pointer-events-none z-20">
          {/* Cue Rest Stand (Stationary at disc outer rim x=81, y=50) */}
          <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full pointer-events-none">
            <rect x="79" y="47" width="4" height="7" rx="1.5" fill="#334155" stroke="#1e293b" strokeWidth="0.5" />
            <path d="M 77 47 Q 81 50 85 47" stroke="#94a3b8" strokeWidth="1" fill="none" />
          </svg>

          {/* Pivoting Tonearm: rotates around gimbal pivot at (78, 18) */}
          <div
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{
              transformOrigin: '78% 18%',
              transform: playing ? 'rotate(0deg)' : 'rotate(-26deg)',
              transition: 'transform 0.55s cubic-bezier(0.25, 1.25, 0.5, 1)',
            }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-xl overflow-visible pointer-events-none">
              <defs>
                <linearGradient id="armTubeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="40%" stopColor="#cbd5e1" />
                  <stop offset="80%" stopColor="#64748b" />
                  <stop offset="100%" stopColor="#334155" />
                </linearGradient>
                <radialGradient id="gimbalGrad" cx="35%" cy="35%" r="65%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="45%" stopColor="#cbd5e1" />
                  <stop offset="75%" stopColor="#64748b" />
                  <stop offset="100%" stopColor="#0f172a" />
                </radialGradient>
              </defs>

              {/* Tonearm Drop Shadow on the Vinyl Below */}
              <g opacity="0.45" transform="translate(1.5, 2.5)">
                <circle cx="78" cy="18" r="5.5" fill="#000" />
                <path d="M 78 22 L 74 38 L 62 54" stroke="#000" strokeWidth="3" strokeLinecap="round" />
                <rect x="56" y="52" width="10" height="12" rx="1.5" fill="#000" />
              </g>

              {/* Rear Counterweight (above pivot) */}
              <rect x="75" y="8" width="6" height="5" rx="1.2" fill="#64748b" stroke="#334155" strokeWidth="0.5" />

              {/* Gimbal Housing Base */}
              <circle cx="78" cy="18" r="5.5" fill="url(#gimbalGrad)" stroke="#475569" strokeWidth="0.8" />
              <circle cx="78" cy="18" r="2" fill="#0f172a" stroke="#94a3b8" strokeWidth="0.5" />

              {/* Stainless Steel Tonearm Tube (S-curved down onto the vinyl grooves) */}
              <path
                d="M 78 22 L 74 38 L 62 54"
                stroke="url(#armTubeGrad)"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />

              {/* Cartridge Headshell (Sitting precisely on the record sound grooves) */}
              <g transform="translate(62, 54) rotate(-24)">
                {/* Cartridge body */}
                <rect x="-4.5" y="0" width="9" height="13" rx="1.5" fill="#181a20" stroke="#475569" strokeWidth="0.6" />
                {/* Silver top plate */}
                <rect x="-3.5" y="1" width="7" height="2.5" rx="0.5" fill="#e2e8f0" />
                {/* Mounting screws */}
                <circle cx="-2" cy="2" r="0.6" fill="#475569" />
                <circle cx="2" cy="2" r="0.6" fill="#475569" />
                {/* Stylus needle (touching groove) */}
                <line x1="0" y1="13" x2="0" y2="15.5" stroke="#fbbf24" strokeWidth="1.2" strokeLinecap="round" />
                {/* Finger lift hook */}
                <path d="M 4.5 4 Q 8 3.5 7 1" stroke="#cbd5e1" strokeWidth="0.8" fill="none" strokeLinecap="round" />
              </g>
            </svg>
          </div>
        </div>
      </div>
    )
  }

  // CD / Vinyl Disc
  if (design === 'cd') {
    return (
      <div
        className={`relative shrink-0 flex items-center justify-center select-none ${
          isHero ? 'h-full max-h-full max-w-full aspect-square' : ''
        }`}
        style={!isHero && size ? { width: size, height: size } : undefined}
      >
        {isPulse && (
          <div
            className="absolute -inset-2 rounded-full pointer-events-none"
            style={{
              border: `2px solid ${visualizerColor}`,
              animation: pulseRingAnimation,
              boxShadow: `0 0 18px ${visualizerColor}`,
            }}
          />
        )}
        {/* Realistic Vinyl Record / CD */}
        <div
          className="relative w-full h-full rounded-full shadow-2xl flex items-center justify-center overflow-hidden"
          style={{
            background: 'radial-gradient(circle, #2c2c32 0%, #17171a 45%, #0c0c0e 72%, #050508 100%)',
            boxShadow: '0 8px 26px rgba(0,0,0,0.7), inset 0 0 4px rgba(255,255,255,0.25)',
            animation: 'spinDisc 5s linear infinite',
            animationPlayState: playing ? 'running' : 'paused',
          }}
        >
          {/* Concentric sound micro-grooves */}
          <div className="absolute inset-[10%] rounded-full border border-white/5 pointer-events-none" />
          <div className="absolute inset-[18%] rounded-full border border-white/5 pointer-events-none" />
          <div className="absolute inset-[26%] rounded-full border border-white/5 pointer-events-none" />
          <div className="absolute inset-[34%] rounded-full border border-white/5 pointer-events-none" />

          {/* Dual vinyl sheen reflections */}
          <div
            className="absolute inset-0 rounded-full pointer-events-none opacity-35 mix-blend-overlay"
            style={{
              background:
                'conic-gradient(from 45deg, rgba(255,255,255,0.45) 0deg, transparent 45deg, transparent 135deg, rgba(255,255,255,0.45) 180deg, transparent 225deg, transparent 315deg, rgba(255,255,255,0.45) 360deg)',
            }}
          />

          {/* Center Album Artwork Circular Label */}
          <div className="relative w-[50%] h-[50%] rounded-full overflow-hidden shadow-inner ring-1 ring-white/20">
            {thumb ? (
              <img src={thumb} alt={title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-zinc-900 flex items-center justify-center">
                <Music className="h-1/3 w-1/3 text-white/40" />
              </div>
            )}
          </div>

          {/* Center Spindle Hole */}
          <div className="absolute w-[12%] h-[12%] rounded-full bg-[#121216] border border-white/30 shadow-inner" />
        </div>
      </div>
    )
  }

  // Circular Disc
  if (design === 'circle') {
    return (
      <div
        className={`relative shrink-0 flex items-center justify-center select-none ${
          isHero ? 'h-full max-h-full max-w-full aspect-square' : ''
        }`}
        style={!isHero && size ? { width: size, height: size } : undefined}
      >
        {isPulse && (
          <div
            className="absolute -inset-1.5 rounded-full pointer-events-none"
            style={{
              border: `2px solid ${visualizerColor}`,
              animation: pulseRingAnimation,
              boxShadow: `0 0 16px ${visualizerColor}`,
            }}
          />
        )}
        {thumb ? (
          <img
            src={thumb}
            alt={title}
            style={{ animation: bounceAnimation }}
            className="w-full h-full rounded-full object-cover shadow-xl ring-2 ring-white/20 transition-all aspect-square"
          />
        ) : (
          <div
            className="w-full h-full rounded-full bg-gradient-to-br from-white/10 to-white/5 border border-white/20 shadow-xl flex items-center justify-center aspect-square"
            style={{ animation: bounceAnimation }}
          >
            <Music className="h-1/3 w-1/3 text-white/50" />
          </div>
        )}
      </div>
    )
  }

  // Classic Square Cover
  return (
    <div
      className={`relative shrink-0 flex items-center justify-center select-none ${
        isHero ? 'h-full max-h-full max-w-full' : ''
      }`}
      style={!isHero && size ? { width: size, height: size } : undefined}
    >
      {isPulse && (
        <div
          className="absolute -inset-1.5 rounded-[12px] pointer-events-none"
          style={{
            border: `2px solid ${visualizerColor}`,
            animation: pulseRingAnimation,
            boxShadow: `0 0 16px ${visualizerColor}`,
          }}
        />
      )}
      {thumb ? (
        <img
          src={thumb}
          alt={title}
          style={{ animation: bounceAnimation }}
          className={`max-h-full max-w-full rounded-[10px] object-cover shadow-xl ring-1 ring-white/15 transition-all ${
            adaptiveRatio ? 'aspect-auto' : 'aspect-square'
          }`}
        />
      ) : (
        <div
          className="h-full w-full rounded-[10px] bg-gradient-to-br from-white/10 to-white/5 border border-white/15 shadow-xl flex items-center justify-center aspect-square"
          style={{ animation: bounceAnimation }}
        >
          <Music className="h-2/5 w-2/5 text-white/40" />
        </div>
      )}
    </div>
  )
}

// ── Interactive Timeline Progress Bar ──
function ProgressBar({
  position,
  duration,
  mode = 'always',
  onSeek,
}: {
  position: number
  duration: number
  mode?: ProgressBarStyle
  onSeek?: (pos: number) => void
}) {
  if (mode === 'hidden') return null
  const isHoverMode = mode === 'hover'
  const barRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragPct, setDragPct] = useState<number | null>(null)

  const currentPct = duration > 0 ? (position / duration) * 100 : 0
  const effectivePct = isDragging && dragPct !== null ? dragPct * 100 : currentPct
  const displayPos = isDragging && dragPct !== null ? dragPct * duration : position

  const calcPct = (clientX: number) => {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (!onSeek || duration <= 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {}
    setIsDragging(true)
    setDragPct(calcPct(e.clientX))
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return
    e.stopPropagation()
    setDragPct(calcPct(e.clientX))
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return
    e.stopPropagation()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
    setIsDragging(false)
    const finalPct = dragPct !== null ? dragPct : calcPct(e.clientX)
    setDragPct(null)
    if (onSeek && duration > 0) {
      onSeek(finalPct * duration)
    }
  }

  return (
    <div
      className={`group/prog flex w-full flex-col gap-1 py-0.5 transition-all duration-200 select-none ${
        isHoverMode ? 'opacity-0 group-hover:opacity-100 pointer-events-auto' : 'opacity-100'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={barRef}
        className="relative flex h-3.5 w-full cursor-pointer items-center py-1"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          setIsDragging(false)
          setDragPct(null)
        }}
      >
        <div className="h-1.5 w-full rounded-full bg-white/20 overflow-hidden relative">
          <div
            className={`h-full bg-[var(--accent)] rounded-full ${
              isDragging ? '' : 'transition-all duration-150'
            }`}
            style={{ width: `${Math.min(100, Math.max(0, effectivePct))}%` }}
          />
        </div>
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full bg-white shadow-md transition-transform pointer-events-none ${
            isDragging ? 'scale-125 ring-2 ring-[var(--accent)]' : 'scale-0 group-hover/prog:scale-100'
          }`}
          style={{ left: `${Math.min(100, Math.max(0, effectivePct))}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-[var(--text-tertiary)] tabular-nums">
        <span className={isDragging ? 'text-[var(--accent)] font-semibold' : ''}>
          {formatTime(displayPos)}
        </span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  )
}

// ── Safe Canvas 2D Color Resolver (Canvas 2D crashes on raw 'var(--accent)') ──
function getSafeCanvasColor(colorStr?: string | null): string {
  if (!colorStr || colorStr.includes('var(')) {
    if (typeof document !== 'undefined') {
      const rootColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      if (rootColor && (rootColor.startsWith('#') || rootColor.startsWith('rgb'))) {
        return rootColor
      }
    }
    return '#38bdf8'
  }
  return colorStr
}

function safeAddColorStop(grad: CanvasGradient, offset: number, col: string, fallback: string) {
  try {
    grad.addColorStop(offset, col)
  } catch {
    grad.addColorStop(offset, fallback)
  }
}

// ── Beat Visualizer Engine (Equalizer Bars, Neon Wave, Monstercat Horizon, Retro VU, Fire Plasma, Pulse) ──
function getTrackBpm(title?: string, artist?: string): number {
  if (!title) return 124
  const lower = (title + ' ' + (artist || '')).toLowerCase()

  // Track & Artist specific high-accuracy tempo detection
  if (lower.includes('plastic love') || lower.includes('takeuchi') || lower.includes('city pop')) return 105
  if (lower.includes('blinding lights') || lower.includes('take on me') || lower.includes('running up that hill')) return 171
  if (lower.includes('venom') || lower.includes('eminem') || lower.includes('godzilla')) return 134
  if (lower.includes('midnight city') || lower.includes('m83')) return 105
  if (lower.includes('stay with me') || lower.includes('miki matsubara')) return 108
  if (lower.includes('flyday chinatown')) return 118
  if (lower.includes('levitating') || lower.includes('don\'t start now') || lower.includes('dua lipa')) return 124
  if (lower.includes('starboy') || lower.includes('daft punk') || lower.includes('one more time') || lower.includes('get lucky')) return 123
  if (lower.includes('fade') || lower.includes('spectre') || lower.includes('alan walker') || lower.includes('faded')) return 90
  if (lower.includes('alone') || lower.includes('marshmello')) return 142
  if (lower.includes('animals') || lower.includes('garrix')) return 128
  if (lower.includes('clarity') || lower.includes('zedd')) return 128
  if (lower.includes('scary monsters') || lower.includes('skrillex') || lower.includes('bangarang')) return 140
  if (lower.includes('monstercat') || lower.includes('ncs') || lower.includes('trap nation') || lower.includes('trap')) return 140
  if (lower.includes('phonk') || lower.includes('drift')) return 140
  if (lower.includes('dnb') || lower.includes('drum and bass') || lower.includes('pendulum') || lower.includes('sub focus')) return 174
  if (lower.includes('lofi') || lower.includes('lo-fi') || lower.includes('chillhop') || lower.includes('sleep')) return 80
  if (lower.includes('hip hop') || lower.includes('rap') || lower.includes('trap') || lower.includes('drake') || lower.includes('kendrick')) return 92
  if (lower.includes('rock') || lower.includes('queen') || lower.includes('ac/dc') || lower.includes('nirvana')) return 118

  // Deterministic musical tempo hash mapping to realistic dance/groove tempos
  let hash = 0
  for (let i = 0; i < lower.length; i++) {
    hash = (hash << 5) - hash + lower.charCodeAt(i)
    hash |= 0
  }
  const tempoBands = [95, 105, 118, 120, 124, 128, 134, 140]
  return tempoBands[Math.abs(hash) % tempoBands.length]!
}

interface VisualizerCanvasProps {
  type: VisualizerType
  playing: boolean
  color?: string
  playbackPos?: number
  title?: string
  artist?: string
}

function VisualizerCanvas({
  type,
  playing,
  color,
  playbackPos = 0,
  title,
  artist,
}: VisualizerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<number[]>([])
  const smoothRef = useRef<number[]>([])
  const needleRef = useRef<number>(0)
  const pulseRingsRef = useRef<{ radius: number; alpha: number }[]>([])
  const posRef = useRef(playbackPos)
  posRef.current = playbackPos

  const bpm = getTrackBpm(title, artist)

  useEffect(() => {
    if (type === 'none') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let lastTime = performance.now()
    let localPos = posRef.current
    let prevBeatInt = -1

    const BIN_COUNT = 32
    if (peaksRef.current.length !== BIN_COUNT) {
      peaksRef.current = new Array(BIN_COUNT).fill(0)
      smoothRef.current = new Array(BIN_COUNT).fill(0)
    }

    const render = (time: number) => {
      const dt = Math.min(0.05, (time - lastTime) / 1000)
      lastTime = time

      if (playing) {
        localPos += dt
        const diff = posRef.current - localPos
        if (Math.abs(diff) > 0.4) {
          localPos = posRef.current
        } else {
          localPos += diff * 0.15
        }
      } else {
        localPos = posRef.current
      }

      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (w === 0 || h === 0) {
        raf = requestAnimationFrame(render)
        return
      }

      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr)
        canvas.height = Math.floor(h * dpr)
      }

      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      const baseColor = getSafeCanvasColor(color)

      // ── High Dynamic Range Beat & Rhythm Engine ──
      const beatSec = 60 / bpm
      const beatProgress = localPos / beatSec
      const beatPhase = beatProgress % 1.0 // 0.0 to 1.0 on every single musical beat
      const currentBeatInt = Math.floor(beatProgress)

      // Spawn expanding shockwave ring on new beat downbeat for 'pulse' or 'halo' mode
      if (playing && currentBeatInt !== prevBeatInt) {
        prevBeatInt = currentBeatInt
        if (type === 'pulse' || type === 'halo') {
          pulseRingsRef.current.push({ radius: Math.max(4, h * 0.15), alpha: 1.0 })
          if (pulseRingsRef.current.length > 8) pulseRingsRef.current.shift()
        }
      }

      // Punchy kick transient (explodes on beat 1 and 3)
      const kick = playing ? Math.pow(Math.max(0, 1 - beatPhase * 3.4), 2.2) : 0
      // Snappy snare impulse (accents beat 2 and 4)
      const snarePhase = (beatPhase + 0.5) % 1.0
      const snare = playing ? Math.pow(Math.max(0, 1 - snarePhase * 3.2), 2.0) : 0
      // 16th-note hi-hat tick
      const hatPhase = (beatProgress * 4) % 1.0
      const hat = playing ? Math.pow(Math.max(0, 1 - hatPhase * 3.8), 1.8) : 0

      // Compute multi-band frequency energies
      for (let i = 0; i < BIN_COUNT; i++) {
        const norm = i / BIN_COUNT
        // Sub-bass & kick (bins 0-7)
        const bass = Math.max(0, 1 - norm * 2.8) * (kick * 0.95 + 0.08)
        // Mid-range vocal & snare (bins 8-20)
        const midDist = Math.abs(norm - 0.44) * 2.6
        const mid = Math.max(0, 1 - midDist) * (snare * 0.85 + 0.12)
        // Treble & percussion shimmer (bins 21-31)
        const treble = Math.max(0, (norm - 0.5) * 2.2) * (hat * 0.8 + 0.1)
        // Musical harmonic cadence
        const harm =
          Math.sin(localPos * 7.5 + i * 0.75) * 0.12 +
          Math.cos(localPos * 4.2 - i * 0.55) * 0.08

        const rawAmp = playing ? Math.min(1.0, Math.max(0.04, bass + mid + treble + harm)) : 0.02
        const targetH = rawAmp * (h - 4)

        const cur = smoothRef.current[i] ?? 0
        if (targetH > cur) {
          smoothRef.current[i] = cur + (targetH - cur) * 0.8 // explosive attack
        } else {
          smoothRef.current[i] = cur * (playing ? 0.83 : 0.7) // natural decay
        }

        const curVal = smoothRef.current[i] ?? 0
        const p = peaksRef.current[i] ?? 0
        if (curVal > p) {
          peaksRef.current[i] = curVal
        } else {
          peaksRef.current[i] = Math.max(2, p - 0.7) // gravitational drop
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 0. CLASSIC LAYER WAVEFORM (OG Harmonic Mirrored Bars)
      // ─────────────────────────────────────────────────────────────
      if (type === 'waveform') {
        const mid = h / 2
        const barW = 3
        const gap = 2
        const n = Math.floor(w / (barW + gap))
        const amp = playing ? 0.95 : 0.08
        const t = localPos * 4.2

        ctx.fillStyle = baseColor

        for (let i = 0; i < n; i++) {
          const x = i * (barW + gap)
          const p = i / n
          const v =
            Math.sin(p * 7 + t) * 0.5 +
            Math.sin(p * 13 - t * 1.4) * 0.3 +
            Math.sin(p * 23 + t * 0.7) * 0.2
          const hh = Math.max(1.5, Math.abs(v) * h * 0.46 * amp + (kick > 0.3 ? kick * 3.5 : 1))

          ctx.beginPath()
          ctx.roundRect(x, mid - hh, barW, hh * 2, 1.5)
          ctx.fill()
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 1. EQUALIZER SPECTRUM BARS (Classic Frequency Bars)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'bars') {
        const gap = 2
        const totalGap = gap * (BIN_COUNT - 1)
        const barW = Math.max(2, (w - totalGap) / BIN_COUNT)

        for (let i = 0; i < BIN_COUNT; i++) {
          const barHeight = Math.max(2.5, Math.min(h - 3, smoothRef.current[i] || 2.5))
          const x = i * (barW + gap)
          const y = h - barHeight
          const peakY = h - Math.min(h - 2, peaksRef.current[i] || 2.5)

          const grad = ctx.createLinearGradient(0, y, 0, h)
          safeAddColorStop(grad, 0, '#ffffff', '#ffffff')
          safeAddColorStop(grad, 0.35, baseColor, '#38bdf8')
          safeAddColorStop(grad, 1, 'rgba(56, 189, 248, 0.1)', 'transparent')
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.roundRect(x, y, barW, barHeight, [2, 2, 0, 0])
          ctx.fill()

          // White specular peak-hold cap
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(x, Math.max(0, peakY - 1.5), barW, 1.5)
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 2. NEON FLUID WAVE (Glowing Sine Ribbon with Ambient Underflow)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'wave') {
        const points: { x: number; y: number }[] = []
        const amp = playing ? h * (0.36 + kick * 0.16) : h * 0.06
        const step = Math.max(3, Math.floor(w / 70))

        for (let x = 0; x <= w; x += step) {
          const normX = (x / w) * Math.PI * 4
          const y =
            h / 2 +
            Math.sin(normX + localPos * (bpm / 60) * 3.14) * amp * 0.7 +
            Math.cos(normX * 2.2 - localPos * 4.2) * amp * 0.3 +
            (kick > 0.25 ? (Math.random() - 0.5) * kick * 5 : 0)
          points.push({ x, y })
        }

        // Ambient gradient underfill
        const firstPt = points[0]
        if (points.length > 1 && firstPt) {
          ctx.beginPath()
          ctx.moveTo(firstPt.x, h)
          ctx.lineTo(firstPt.x, firstPt.y)
          for (let i = 1; i < points.length; i++) {
            const pt = points[i]
            if (pt) ctx.lineTo(pt.x, pt.y)
          }
          ctx.lineTo(w, h)
          ctx.closePath()

          const fillGrad = ctx.createLinearGradient(0, 0, 0, h)
          safeAddColorStop(fillGrad, 0, 'rgba(56, 189, 248, 0.28)', 'transparent')
          safeAddColorStop(fillGrad, 1, 'rgba(56, 189, 248, 0.02)', 'transparent')
          ctx.fillStyle = fillGrad
          ctx.fill()
        }

        // Glowing foreground stroke
        ctx.beginPath()
        ctx.lineWidth = 2.4
        ctx.strokeStyle = '#ffffff'
        ctx.shadowColor = baseColor
        ctx.shadowBlur = playing ? 12 : 3

        if (firstPt) {
          ctx.moveTo(firstPt.x, firstPt.y)
          for (let i = 1; i < points.length; i++) {
            const pt = points[i]
            if (pt) ctx.lineTo(pt.x, pt.y)
          }
          ctx.stroke()
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 3. MONSTERCAT HORIZON (Center Bass Core + Symmetrical Spectrum)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'radial') {
        const midX = w / 2
        const cy = h / 2
        const halfBins = Math.floor(BIN_COUNT / 2)
        const coreRadius = Math.max(6, Math.min(h * 0.36, 16) + kick * 4)

        // Pulsing glowing center core
        ctx.beginPath()
        ctx.arc(midX, cy, coreRadius, 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.shadowColor = baseColor
        ctx.shadowBlur = playing ? 14 : 2
        ctx.fill()

        ctx.beginPath()
        ctx.arc(midX, cy, coreRadius + 3, 0, Math.PI * 2)
        ctx.strokeStyle = baseColor
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.shadowBlur = 0

        // Symmetrical spectrum spreading outwards across the entire width
        const sideW = midX - coreRadius - 8
        if (sideW > 20) {
          const barW = Math.max(2, (sideW - halfBins * 2) / halfBins)
          const gap = 2

          for (let i = 0; i < halfBins; i++) {
            const barH = Math.max(2, Math.min(h - 4, (smoothRef.current[i] || 2) * 1.1))

            // Right side
            const rx = midX + coreRadius + 6 + i * (barW + gap)
            // Left side
            const lx = midX - coreRadius - 6 - (i + 1) * (barW + gap)
            const y = (h - barH) / 2

            const grad = ctx.createLinearGradient(0, y, 0, y + barH)
            safeAddColorStop(grad, 0, '#ffffff', '#ffffff')
            safeAddColorStop(grad, 0.5, baseColor, '#38bdf8')
            safeAddColorStop(grad, 1, 'rgba(255, 255, 255, 0.1)', 'transparent')
            ctx.fillStyle = grad

            ctx.beginPath()
            ctx.roundRect(rx, y, barW, barH, 2)
            ctx.fill()

            ctx.beginPath()
            ctx.roundRect(lx, y, barW, barH, 2)
            ctx.fill()
          }
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 4. RETRO ANALOG VU METER (Studio Ballistic Needles + Peak LEDs)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'vu') {
        const meterW = Math.max(40, (w - 10) / 2)
        // High-sensitivity ballistic drive: hits red zone on kicks!
        const targetVal = playing
          ? Math.min(1.0, 0.12 + kick * 0.72 + (smoothRef.current[2] || 0) / (h - 4) * 0.55)
          : 0
        needleRef.current += (targetVal - needleRef.current) * (targetVal > needleRef.current ? 0.75 : 0.22)
        const needleVal = Math.min(1.0, Math.max(0, needleRef.current))

        const drawSingleVUMeter = (offsetX: number, label: string) => {
          ctx.save()
          ctx.translate(offsetX, 0)

          // Backlit warm vintage cream/amber meter housing
          const bgGrad = ctx.createLinearGradient(0, 0, 0, h)
          safeAddColorStop(bgGrad, 0, '#27272a', '#27272a')
          safeAddColorStop(bgGrad, 1, '#18181b', '#18181b')
          ctx.fillStyle = bgGrad
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)'
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.roundRect(0, 0, meterW, h, 6)
          ctx.fill()
          ctx.stroke()

          // Vintage backlit warm glow across the dial face
          const dialGrad = ctx.createRadialGradient(meterW / 2, h * 0.4, 2, meterW / 2, h * 0.4, meterW * 0.6)
          safeAddColorStop(dialGrad, 0, 'rgba(254, 243, 199, 0.15)', 'transparent')
          safeAddColorStop(dialGrad, 1, 'rgba(0, 0, 0, 0.25)', 'transparent')
          ctx.fillStyle = dialGrad
          ctx.beginPath()
          ctx.roundRect(1, 1, meterW - 2, h - 2, 5)
          ctx.fill()

          // Geometry: pivot at bottom center
          const pivotX = meterW / 2
          const pivotY = h - 1
          const r = Math.max(16, h * 0.82)
          const startAngle = -Math.PI * 0.8
          const endAngle = -Math.PI * 0.2

          // Normal Scale Arc (Warm Amber)
          ctx.beginPath()
          ctx.arc(pivotX, pivotY, r, startAngle, endAngle - 0.18)
          ctx.strokeStyle = '#f59e0b'
          ctx.lineWidth = 2
          ctx.stroke()

          // Overload Arc (> 0dB, Bright Red)
          ctx.beginPath()
          ctx.arc(pivotX, pivotY, r, endAngle - 0.18, endAngle)
          ctx.strokeStyle = '#ef4444'
          ctx.lineWidth = 2.5
          ctx.stroke()

          // Tick marks on arc
          const ticks = [
            { a: startAngle, txt: '-20' },
            { a: startAngle + 0.32, txt: '-10' },
            { a: startAngle + 0.62, txt: '0' },
            { a: endAngle, txt: '+3' },
          ]
          ctx.fillStyle = 'rgba(255, 255, 255, 0.65)'
          ctx.font = '7.5px monospace'
          for (const t of ticks) {
            const innerR = r - 3
            const outerR = r + 2
            const tx1 = pivotX + Math.cos(t.a) * innerR
            const ty1 = pivotY + Math.sin(t.a) * innerR
            const tx2 = pivotX + Math.cos(t.a) * outerR
            const ty2 = pivotY + Math.sin(t.a) * outerR

            ctx.beginPath()
            ctx.moveTo(tx1, ty1)
            ctx.lineTo(tx2, ty2)
            ctx.strokeStyle = t.txt === '+3' ? '#ef4444' : 'rgba(255, 255, 255, 0.5)'
            ctx.lineWidth = 1
            ctx.stroke()

            const labelX = pivotX + Math.cos(t.a) * (r - 7)
            const labelY = pivotY + Math.sin(t.a) * (r - 7)
            ctx.fillText(t.txt, Math.max(2, Math.min(meterW - 14, labelX - 5)), Math.max(8, labelY))
          }

          // Active Ballistic Needle
          const needleAngle = startAngle + needleVal * (endAngle - startAngle)
          const tipX = pivotX + Math.cos(needleAngle) * r
          const tipY = pivotY + Math.sin(needleAngle) * r

          // Needle shadow
          ctx.beginPath()
          ctx.moveTo(pivotX + 1, pivotY + 1)
          ctx.lineTo(tipX + 1, tipY + 1)
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
          ctx.lineWidth = 2
          ctx.stroke()

          // Foreground needle
          ctx.beginPath()
          ctx.moveTo(pivotX, pivotY)
          ctx.lineTo(tipX, tipY)
          const isOverload = needleVal > 0.72
          ctx.strokeStyle = isOverload ? '#ef4444' : '#ffffff'
          ctx.shadowColor = isOverload ? '#ef4444' : '#ffffff'
          ctx.shadowBlur = isOverload ? 8 : 2
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.shadowBlur = 0

          // Pivot pin cap
          ctx.beginPath()
          ctx.arc(pivotX, pivotY, 3, 0, Math.PI * 2)
          ctx.fillStyle = '#f59e0b'
          ctx.fill()
          ctx.beginPath()
          ctx.arc(pivotX, pivotY, 1.5, 0, Math.PI * 2)
          ctx.fillStyle = '#09090b'
          ctx.fill()

          // Channel Label
          ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
          ctx.font = 'bold 8px sans-serif'
          ctx.fillText(label, 6, 11)

          // Red Peak LED indicator
          const isPeak = needleVal > 0.72
          ctx.fillStyle = isPeak ? '#ef4444' : '#450a0a'
          if (isPeak) {
            ctx.shadowColor = '#ef4444'
            ctx.shadowBlur = 8
          }
          ctx.beginPath()
          ctx.arc(meterW - 8, 8, 2.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowBlur = 0

          ctx.restore()
        }

        drawSingleVUMeter(0, 'CH-L')
        drawSingleVUMeter(meterW + 10, 'CH-R')
      }

      // 5. LIQUID FIRE PLASMA (Organic Molten Flames Dancing to the Beat)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'plasma') {
        const points = 24
        const step = w / (points - 1)

        ctx.beginPath()
        ctx.moveTo(0, h)

        for (let i = 0; i < points; i++) {
          const x = i * step
          const binIdx = Math.floor((i / points) * BIN_COUNT)
          const energy = (smoothRef.current[binIdx] || 2) / (h - 4)
          const flameH = Math.max(3, energy * (h - 2) * 1.05 + kick * 5)
          const y = h - flameH

          if (i === 0) {
            ctx.lineTo(x, y)
          } else {
            const prevX = (i - 1) * step
            const cX = (prevX + x) / 2
            ctx.quadraticCurveTo(prevX, y, cX, y)
          }
        }

        ctx.lineTo(w, h)
        ctx.closePath()

        const fireGrad = ctx.createLinearGradient(0, 0, 0, h)
        safeAddColorStop(fireGrad, 0, '#ffffff', '#ffffff')
        safeAddColorStop(fireGrad, 0.25, '#fbbf24', '#f59e0b')
        safeAddColorStop(fireGrad, 0.6, '#ef4444', '#dc2626')
        safeAddColorStop(fireGrad, 1, 'rgba(185, 28, 28, 0.1)', 'transparent')
        ctx.fillStyle = fireGrad
        ctx.shadowColor = '#f59e0b'
        ctx.shadowBlur = playing ? 10 : 2
        ctx.fill()
        ctx.shadowBlur = 0
      }

      // ─────────────────────────────────────────────────────────────
      // 6. BEAT PULSE SHOCKWAVE (Rhythmic Radar Waves Expanding on Kick)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'pulse') {
        const cx = w / 2
        const cy = h / 2

        // Expanding concentric shockwave rings
        for (let i = pulseRingsRef.current.length - 1; i >= 0; i--) {
          const ring = pulseRingsRef.current[i]
          if (!ring) continue
          ring.radius += 2.8
          ring.alpha *= 0.94

          if (ring.alpha <= 0.04 || ring.radius > w) {
            pulseRingsRef.current.splice(i, 1)
            continue
          }

          ctx.beginPath()
          ctx.arc(cx, cy, ring.radius, 0, Math.PI * 2)
          ctx.strokeStyle = baseColor
          ctx.globalAlpha = ring.alpha
          ctx.lineWidth = 2
          ctx.shadowColor = baseColor
          ctx.shadowBlur = 8
          ctx.stroke()
          ctx.globalAlpha = 1.0
          ctx.shadowBlur = 0
        }

        // Central glowing kick flare
        const flareR = Math.max(4, Math.min(h * 0.4, 20) * (0.4 + kick * 0.8))
        ctx.beginPath()
        ctx.arc(cx, cy, flareR, 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.shadowColor = baseColor
        ctx.shadowBlur = 14
        ctx.fill()
        ctx.shadowBlur = 0

        // Subtitle horizontal rhythm beam
        const beamW = (w * 0.4) * (0.3 + kick * 0.7)
        ctx.fillStyle = baseColor
        ctx.globalAlpha = 0.4 + kick * 0.6
        ctx.fillRect(cx - beamW / 2, cy - 1, beamW, 2)
        ctx.globalAlpha = 1.0
      }

      // ─────────────────────────────────────────────────────────────
      // 7. CYBER SOUNDWAVE DOTS (Illuminated Capsule Matrix)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'dots') {
        const colCount = 20
        const dotRows = 5
        const gapX = 3
        const dotW = Math.max(2, (w - gapX * (colCount - 1)) / colCount)
        const dotH = Math.max(2, (h - (dotRows - 1) * 2) / dotRows)

        for (let c = 0; c < colCount; c++) {
          const binIdx = Math.floor((c / colCount) * BIN_COUNT)
          const ampNorm = Math.min(1.0, (smoothRef.current[binIdx] || 0) / (h - 4))
          const activeDots = Math.ceil(ampNorm * dotRows)

          for (let r = 0; r < dotRows; r++) {
            const dotY = h - (r + 1) * (dotH + 2)
            const dotX = c * (dotW + gapX)
            const isLit = r < activeDots

            if (isLit) {
              const isTop = r === activeDots - 1
              ctx.fillStyle = isTop ? '#ffffff' : baseColor
              ctx.shadowColor = isTop ? '#ffffff' : baseColor
              ctx.shadowBlur = isTop ? 4 : 0
            } else {
              ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
              ctx.shadowBlur = 0
            }

            ctx.beginPath()
            ctx.roundRect(dotX, dotY, dotW, dotH, 1.5)
            ctx.fill()
          }
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 8. RADIAL SPECTRUM HALO (Trap Nation 360° Circular Speaker Spectrum)
      // ─────────────────────────────────────────────────────────────
      else if (type === 'halo') {
        const cx = w / 2
        const cy = h / 2
        const minDim = Math.min(w, h)
        const RAY_COUNT = 48
        const rInner = Math.max(6, minDim * 0.22 * (0.9 + kick * 0.2))
        const maxRayLen = Math.max(6, minDim * 0.24)

        // Pulsing glowing center subwoofer dust cap
        ctx.beginPath()
        ctx.arc(cx, cy, rInner - 1, 0, Math.PI * 2)
        ctx.fillStyle = '#18181b'
        ctx.shadowColor = baseColor
        ctx.shadowBlur = playing ? 14 : 2
        ctx.fill()

        ctx.beginPath()
        ctx.arc(cx, cy, rInner - 1, 0, Math.PI * 2)
        ctx.strokeStyle = baseColor
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.shadowBlur = 0

        // Subwoofer center specular highlight
        ctx.beginPath()
        ctx.arc(cx - rInner * 0.25, cy - rInner * 0.25, rInner * 0.35, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'
        ctx.fill()

        // Expanding shockwave rings on downbeats
        for (let i = pulseRingsRef.current.length - 1; i >= 0; i--) {
          const ring = pulseRingsRef.current[i]
          if (!ring) continue
          ring.radius += 2.5
          ring.alpha *= 0.93

          if (ring.alpha <= 0.04 || ring.radius > w) {
            pulseRingsRef.current.splice(i, 1)
            continue
          }

          ctx.beginPath()
          ctx.arc(cx, cy, ring.radius, 0, Math.PI * 2)
          ctx.strokeStyle = baseColor
          ctx.globalAlpha = ring.alpha
          ctx.lineWidth = 1.6
          ctx.stroke()
          ctx.globalAlpha = 1.0
        }

        // 360° Radial Equalizer Bars
        for (let i = 0; i < RAY_COUNT; i++) {
          const angle = (i / RAY_COUNT) * Math.PI * 2 - Math.PI / 2
          const binIdx = Math.floor(Math.abs(Math.sin(angle)) * (BIN_COUNT - 1))
          const energy = (smoothRef.current[binIdx] || 2) / (h - 4)
          const barLen = Math.max(2.5, Math.min(maxRayLen, energy * maxRayLen * 1.1 + kick * 4))

          const x1 = cx + Math.cos(angle) * rInner
          const y1 = cy + Math.sin(angle) * rInner
          const x2 = cx + Math.cos(angle) * (rInner + barLen)
          const y2 = cy + Math.sin(angle) * (rInner + barLen)

          const grad = ctx.createLinearGradient(x1, y1, x2, y2)
          safeAddColorStop(grad, 0, baseColor, '#38bdf8')
          safeAddColorStop(grad, 0.75, baseColor, '#38bdf8')
          safeAddColorStop(grad, 1, '#ffffff', '#ffffff')

          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.strokeStyle = grad
          ctx.lineWidth = Math.max(1.8, Math.min(3.2, (2 * Math.PI * rInner) / RAY_COUNT * 0.65))
          ctx.lineCap = 'round'
          ctx.shadowColor = baseColor
          ctx.shadowBlur = playing ? 8 : 1
          ctx.stroke()
          ctx.shadowBlur = 0
        }
      }

      ctx.restore()
      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [type, playing, color, bpm])

  if (type === 'none') return null
  return <canvas ref={canvasRef} className="h-full w-full pointer-events-none" />
}

// ── Multi-Texture Lyrics Styling (Song Adaptive, PC Wallpaper, Venom, Chrome, Neon, Fire) ──
function getLyricsStyle(
  style: LyricsStyle,
  isActive: boolean,
  artRgb?: string | null,
  wallpaperAccent?: string | null,
): CSSProperties {
  if (!isActive) {
    return {
      color: 'rgba(255, 255, 255, 0.35)',
      fontSize: '12.5px',
      fontWeight: 500,
    }
  }

  switch (style) {
    case 'songAdaptive': {
      // Dynamically extracts vibrant palette from active song album cover
      const songColor = artRgb || 'rgb(56, 189, 248)'
      return {
        backgroundImage: `linear-gradient(135deg, #ffffff 0%, ${songColor} 45%, #ffffff 75%, ${songColor} 100%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        filter: `drop-shadow(0 0 12px ${songColor}) drop-shadow(0 2px 4px rgba(0,0,0,0.9))`,
        fontWeight: 800,
        letterSpacing: '-0.3px',
        fontSize: '15px',
      }
    }
    case 'wallpaper': {
      // Dynamically adapts to Windows PC desktop wallpaper accent!
      const wallColor = wallpaperAccent || 'var(--accent, #38bdf8)'
      return {
        backgroundImage: `linear-gradient(135deg, #ffffff 0%, ${wallColor} 40%, #ffffff 70%, ${wallColor} 100%)`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        filter: `drop-shadow(0 0 12px ${wallColor}) drop-shadow(0 2px 4px rgba(0,0,0,0.9))`,
        fontWeight: 800,
        letterSpacing: '-0.3px',
        fontSize: '15px',
      }
    }
    case 'venom': {
      // Venom Symbiote: Liquid stark marbled monochrome with dark tendril veins & oily gloss highlight
      return {
        backgroundImage:
          'linear-gradient(135deg, #ffffff 0%, #cbd5e1 20%, #334155 42%, #09090b 52%, #1e293b 62%, #f1f5f9 82%, #ffffff 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        filter:
          'drop-shadow(0 2px 5px rgba(0,0,0,0.95)) drop-shadow(0 0 10px rgba(255,255,255,0.75))',
        fontWeight: 800,
        letterSpacing: '-0.3px',
        fontSize: '15px',
      }
    }
    case 'chrome': {
      // Liquid Specular Chrome reflection
      return {
        backgroundImage:
          'linear-gradient(180deg, #ffffff 0%, #cbd5e1 35%, #1e293b 48%, #020617 52%, #94a3b8 65%, #ffffff 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        filter:
          'drop-shadow(0 2px 4px rgba(0,0,0,0.9)) drop-shadow(0 0 6px rgba(203,213,225,0.7))',
        fontWeight: 800,
        fontSize: '15px',
      }
    }
    case 'neon': {
      // Cyber Electric Neon
      return {
        backgroundImage: 'linear-gradient(90deg, #38bdf8 0%, #c084fc 50%, #f43f5e 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        filter:
          'drop-shadow(0 0 8px #38bdf8) drop-shadow(0 0 16px rgba(244,63,94,0.85))',
        fontWeight: 800,
        fontSize: '15px',
      }
    }
    case 'fire': {
      // Molten Magma Ember
      return {
        backgroundImage:
          'linear-gradient(180deg, #fffbeb 0%, #fde047 25%, #f97316 60%, #b91c1c 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        filter:
          'drop-shadow(0 0 10px rgba(249,115,22,0.85)) drop-shadow(0 2px 4px rgba(0,0,0,0.9))',
        fontWeight: 800,
        fontSize: '15px',
      }
    }
    case 'clean':
    default:
      return {
        color: '#ffffff',
        filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.7))',
        fontWeight: 700,
        fontSize: '14.5px',
      }
  }
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const rem = Math.floor(s % 60)
  return `${m}:${rem.toString().padStart(2, '0')}`
}

// ── Presets Configuration ──
export const PRESET_CONFIGS: Record<string, Partial<NowPlayingWidgetType>> = {
  compact: {
    preset: 'compact',
    artLayout: 'left',
    artDesign: 'square',
    layoutSizing: 'fluid',
    volumeStyle: 'hover',
    backgroundStyle: 'glass',
    visualizerType: 'none',
    progressBarStyle: 'hover',
    controlsLayout: 'bottom-right',
    buttonSize: 'compact',
    lyricsStyle: 'venom',
    artBackground: true,
  },
  hero: {
    preset: 'hero',
    artLayout: 'hero',
    artDesign: 'square',
    layoutSizing: 'fluid',
    volumeStyle: 'bar',
    backgroundStyle: 'glass',
    visualizerType: 'bars',
    progressBarStyle: 'always',
    controlsLayout: 'bottom-center',
    buttonSize: 'large',
    adaptiveArtRatio: true,
    lyricsStyle: 'venom',
    artBackground: true,
  },
  classic: {
    preset: 'classic',
    artLayout: 'left',
    artDesign: 'cd',
    layoutSizing: 'fluid',
    volumeStyle: 'knob',
    backgroundStyle: 'glass',
    visualizerType: 'none',
    progressBarStyle: 'hidden',
    controlsLayout: 'bottom-right',
    buttonSize: 'compact',
    lyricsStyle: 'off',
    artBackground: true,
  },
  transparent: {
    preset: 'transparent',
    artLayout: 'left',
    artDesign: 'square',
    layoutSizing: 'fluid',
    backgroundStyle: 'transparent',
    artBackground: false,
    volumeStyle: 'hover',
    progressBarStyle: 'hover',
    controlsLayout: 'bottom-right',
    buttonSize: 'compact',
    lyricsStyle: 'venom',
  },
  custom: {
    preset: 'custom',
  },
}

// ── Main Widget Renderer ──
export function NowPlayingRenderer({ widget }: { widget: NowPlayingWidgetType }) {
  const { t } = useTranslation()
  const [mockIndex, setMockIndex] = useState<number>(0)
  const currentMock = MOCK_PLAYLIST[mockIndex] || MOCK_PLAYLIST[0]!

  const [session, setSession] = useState<NowPlaying | null>(() =>
    isTauri()
      ? null
      : {
          hasSession: true,
          title: currentMock.title,
          artist: currentMock.artist,
          playing: true,
          thumb: currentMock.thumb,
          source: currentMock.source,
          position: 0,
          duration: currentMock.duration,
        },
  )
  const [vol, setVol] = useState<number>(0.75)
  const lastSyncRef = useRef<{ pos: number; time: number; playing: boolean }>({
    pos: 0,
    time: performance.now(),
    playing: false,
  })
  const [livePos, setLivePos] = useState<number>(0)
  const [isPlaying, setIsPlaying] = useState<boolean>(true)
  const [isLooping, setIsLooping] = useState<boolean>(false)
  const [discoveredThumb, setDiscoveredThumb] = useState<string | null>(null)
  const lastSeekTimeRef = useRef<number>(0)
  const liveAudioPeakRef = useRef<number>(0)
  const [lyrics, setLyrics] = useState<LyricLine[]>(() => parseLrc(currentMock.lyrics))
  const [activeLyricIdx, setActiveLyricIdx] = useState<number>(0)
  const [isKaraokeOpen, setIsKaraokeOpen] = useState<boolean>(false)
  const [wallpaperAccent, setWallpaperAccent] = useState<string | null>(null)
  const lyricsContainerRef = useRef<HTMLDivElement>(null)


  useEffect(() => {
    const updateWallpaper = () => {
      if (isTauri()) {
        getWallpaperAccent()
          .then((hex) => {
            if (hex && /^#[0-9a-f]{6}$/i.test(hex)) setWallpaperAccent(hex)
          })
          .catch(() => {})
      } else {
        const rootAccent = getComputedStyle(document.documentElement)
          .getPropertyValue('--accent')
          .trim()
        if (rootAccent) setWallpaperAccent(rootAccent)
      }
    }
    updateWallpaper()
  }, [])

  // Real-time Hardware Audio Peak Listener
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | null = null
    listen<number>('audio-peak', (e) => {
      liveAudioPeakRef.current = e.payload
    })
      .then((un) => {
        unlisten = un
      })
      .catch(() => {})
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  // Online High-Definition Cover Art Fallback (for YouTube / Browser Streams)
  useEffect(() => {
    if (!session?.title) {
      setDiscoveredThumb(null)
      return
    }
    const isPlaceholder = !session.thumb || session.thumb.length < 3500
    if (!isPlaceholder && session.thumb.length > 0) {
      return
    }
    let cancelled = false
    fetchCoverArt(session.title, session.artist).then((art) => {
      if (!cancelled && art) setDiscoveredThumb(art)
    })
    return () => {
      cancelled = true
    }
  }, [session?.title, session?.artist, session?.thumb])

  // Widget settings with clean defaults
  const preset = widget.preset || 'compact'
  const artDesign: ArtDesign = widget.artDesign || 'square'
  const artLayout: ArtLayout = widget.artLayout || (preset === 'hero' ? 'hero' : 'left')
  const layoutSizing: LayoutSizing = widget.layoutSizing || 'fluid'
  const isFluid = layoutSizing === 'fluid'
  const widgetH = widget.height || 145
  const fluidThumbSize = isFluid
    ? Math.max(64, Math.min(200, Math.round(widgetH * 0.54)))
    : 64
  const titleFontSize = isFluid
    ? Math.max(15, Math.min(23, Math.round(15 + (fluidThumbSize - 64) * 0.08)))
    : 15
  const artistFontSize = isFluid
    ? Math.max(12, Math.min(16, Math.round(12.5 + (fluidThumbSize - 64) * 0.035)))
    : 12.5

  const volumeStyle = widget.volumeStyle || (preset === 'classic' ? 'knob' : preset === 'hero' ? 'bar' : 'hover')
  const progressBarStyle = widget.progressBarStyle || (preset === 'compact' ? 'hover' : 'always')
  const visualizerType = widget.visualizerType || (preset === 'hero' ? 'bars' : 'none')
  const lyricsStyle = widget.lyricsStyle || 'venom'
  const controlsLayout: ControlsLayout = widget.controlsLayout || (artLayout === 'hero' ? 'bottom-center' : 'bottom-right')
  const isLargeButtons = widget.buttonSize === 'large'
  const showLoop = widget.showLoop === true
  const adaptiveArtRatio = widget.adaptiveArtRatio === true
  const backgroundStyle = widget.backgroundStyle || (preset === 'transparent' ? 'transparent' : 'glass')
  const artBackground = widget.artBackground !== false
  const infoAlignment: InfoAlignment = widget.infoAlignment || (artLayout === 'hero' ? 'center' : 'left')
  const infoTypography: InfoTypography = widget.infoTypography || 'modern'
  const infoDensity: InfoDensity = widget.infoDensity || 'stacked'
  const showArtist = widget.showArtist !== false
  const showSourceHeader = widget.showSourceHeader !== false
  const marqueeScroll = widget.marqueeScroll === true
  const cardPadding = widget.cardPadding || 'normal'
  const paddingClass = cardPadding === 'compact' ? 'p-2' : cardPadding === 'relaxed' ? 'p-5' : 'p-3.5'
  const elementGap = widget.elementGap || 'normal'
  const gapClass = elementGap === 'tight' ? 'gap-1' : elementGap === 'relaxed' ? 'gap-2.5' : 'gap-1.5'

  // Internal Element HUD layout & interactive screen dragging
  const hudLayout = widget.hudLayout || {}
  const hudEditMode = widget.hudEditMode === true && !widget.locked
  const hudSelectedElement = widget.hudSelectedElement || 'controls'

  const handleHudSelect = (key: WidgetElementKey) => {
    useCanvasStore.getState().updateWidget(widget.id, {
      hudSelectedElement: key,
    })
  }

  const handleHudMove = (key: WidgetElementKey, newX: number, newY: number) => {
    const prevHud = widget.hudLayout || {}
    const currentElem = prevHud[key] || { x: 0, y: 0, scale: 1.0 }
    useCanvasStore.getState().updateWidget(widget.id, {
      hudLayout: {
        ...prevHud,
        [key]: {
          ...currentElem,
          x: Math.round(newX),
          y: Math.round(newY),
        },
      },
      preset: 'custom',
    })
  }

  // Sync mock track changes
  useEffect(() => {
    if (isTauri()) return
    const cur = MOCK_PLAYLIST[mockIndex] || MOCK_PLAYLIST[0]!
    setSession({
      hasSession: true,
      title: cur.title,
      artist: cur.artist,
      playing: isPlaying,
      thumb: cur.thumb,
      source: cur.source,
      position: 0,
      duration: cur.duration,
    })
    lastSyncRef.current = { pos: 0, time: performance.now(), playing: isPlaying }
    setLivePos(0)
    setLyrics(parseLrc(cur.lyrics))
  }, [mockIndex])

  // Desktop IPC Polling
  useEffect(() => {
    if (!isTauri()) return
    let active = true
    const poll = async () => {
      try {
        const [np, v] = await Promise.all([getNowPlaying(), getVolume()])
        if (!active) return
        setSession(np)
        if (typeof v === 'number' && Number.isFinite(v)) setVol(v)
        if (np?.hasSession) {
          const isRecentlySeeked = performance.now() - lastSeekTimeRef.current < 2500
          const closeEnough = Math.abs((np.position || 0) - lastSyncRef.current.pos) < 1.0
          if (!isRecentlySeeked || closeEnough) {
            lastSyncRef.current = {
              pos: np.position || 0,
              time: performance.now(),
              playing: np.playing,
            }
          }
        }
      } catch {
        // Fallback
      }
    }
    poll()
    const id = setInterval(poll, 1000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  // High-precision smooth position interpolator (1:1 lockstep with real audio, zero drift, stops when paused)
  const playingState = session?.playing ?? isPlaying
  useEffect(() => {
    if (!playingState) {
      if (isTauri()) {
        setLivePos(lastSyncRef.current.pos)
      }
      return
    }
    const id = setInterval(() => {
      if (isTauri()) {
        const { pos, time, playing } = lastSyncRef.current
        if (playing) {
          const elapsed = (performance.now() - time) / 1000
          const dur = session?.duration || 0
          const current = dur > 0 ? Math.min(dur, pos + elapsed) : pos + elapsed
          setLivePos(current)
          if (isLooping && dur > 0 && current >= dur - 0.35) {
            handleSeek(0)
          }
        }
      } else {
        if (isPlaying) {
          setLivePos((p) => {
            const dur = currentMock.duration
            if (p >= dur) return isLooping ? 0 : 0
            return +(p + 0.1).toFixed(2)
          })
        }
      }
    }, 100)
    return () => clearInterval(id)
  }, [playingState, session?.duration, currentMock.duration, isLooping, isPlaying])

  const playbackPos = livePos

  // Synced Lyrics Loader for desktop mode
  useEffect(() => {
    if (!isTauri() || !session?.title) return
    let cancelled = false

    // 1. If user provided custom transcript / LRC, use it immediately
    if (widget.customLrc && widget.customLrc.trim().length > 0) {
      setLyrics(parseLrc(widget.customLrc))
      return
    }

    const fetchLyrics = async () => {
      try {
        const allowAutoYt = widget.autoFetchYoutubeCaptions !== false
        const isBrowserSource = /chrome|edge|firefox|opera|brave|youtube/i.test(session.source || '')

        // 2. Check for YouTube Video ID (specified in widget settings, or detected in thumbnail/title)
        const detectedYtId =
          widget.youtubeVideoId ||
          extractYouTubeVideoId(session.thumb) ||
          extractYouTubeVideoId(session.title)

        if (allowAutoYt && detectedYtId) {
          const ytCaptions = await fetchYouTubeCaptions(detectedYtId)
          if (cancelled) return
          if (ytCaptions.length > 0) {
            setLyrics(ytCaptions)
            return
          }
        }

        const { title: cleanTitle, artist: cleanArtist } = cleanTrackTitle(session.title, session.artist)

        // 3. Query LRCLIB with cleaned title and artist (stripping YouTube video tags, MV, 4K, etc.)
        const qClean = encodeURIComponent(`${cleanTitle} ${cleanArtist}`.trim())
        const res = await fetch(`https://lrclib.net/api/search?q=${qClean}`)
        if (res.ok) {
          const data = await res.json()
          if (cancelled) return
          if (Array.isArray(data) && data.length > 0) {
            const match = data.find((d) => d?.syncedLyrics) || data[0]
            if (match?.syncedLyrics) {
              setLyrics(parseLrc(match.syncedLyrics))
              return
            }
          }
        }

        // 3b. Query LRCLIB with cleaned title alone
        if (cleanTitle.length > 2) {
          try {
            const qT = encodeURIComponent(cleanTitle.trim())
            const resT = await fetch(`https://lrclib.net/api/search?q=${qT}`)
            if (resT.ok) {
              const dataT = await resT.json()
              if (cancelled) return
              if (Array.isArray(dataT) && dataT.length > 0) {
                const match = dataT.find((d) => d?.syncedLyrics) || dataT[0]
                if (match?.syncedLyrics) {
                  setLyrics(parseLrc(match.syncedLyrics))
                  return
                }
              }
            }
          } catch {}
        }

        // 3c. Query Netease Cloud Music API (huge library of international, Indian, and regional music)
        try {
          const netRes = await fetch(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(cleanTitle)}&type=1&offset=0&total=true&limit=1`)
          if (netRes.ok) {
            const nData = await netRes.json()
            const sId = nData?.result?.songs?.[0]?.id
            if (sId) {
              const lrcRes = await fetch(`https://music.163.com/api/song/lyric?os=pc&id=${sId}&lv=-1&kv=-1&tv=-1`)
              if (lrcRes.ok) {
                const lrcData = await lrcRes.json()
                if (cancelled) return
                const rawLrc = lrcData?.lrc?.lyric
                if (rawLrc && rawLrc.includes('[')) {
                  const parsed = parseLrc(rawLrc)
                  if (parsed.length > 0) {
                    setLyrics(parsed)
                    return
                  }
                }
              }
            }
          }
        } catch {}

        // 4. Fallback: try raw title query if clean title was different
        if (cleanTitle !== session.title) {
          const qRaw = encodeURIComponent(session.title)
          const resRaw = await fetch(`https://lrclib.net/api/search?q=${qRaw}`)
          if (resRaw.ok) {
            const dataRaw = await resRaw.json()
            if (cancelled) return
            if (Array.isArray(dataRaw) && dataRaw.length > 0) {
              const match = dataRaw.find((d) => d?.syncedLyrics) || dataRaw[0]
              if (match?.syncedLyrics) {
                setLyrics(parseLrc(match.syncedLyrics))
                return
              }
            }
          }
        }

        // 5. If it's a browser session and LRCLIB had no lyrics, try auto-searching YouTube for captions
        if (allowAutoYt && isBrowserSource && cleanTitle.length > 3) {
          try {
            const searchRes = await fetch(`https://invidious.nerdvpn.de/api/v1/search?q=${encodeURIComponent(cleanTitle)}&type=video`)
            if (searchRes.ok) {
              const searchData = await searchRes.json()
              if (cancelled) return
              if (Array.isArray(searchData) && searchData[0]?.videoId) {
                const autoCaptions = await fetchYouTubeCaptions(searchData[0].videoId)
                if (cancelled) return
                if (autoCaptions.length > 0) {
                  setLyrics(autoCaptions)
                  return
                }
              }
            }
          } catch {
            // Ignore search error
          }
        }

        // 6. No synced lyrics found in music database (e.g. podcast, YouTube talk, unreleased track)
        // Set empty array so we show the Podcast/Video transcript UI rather than random songs!
        if (!cancelled) setLyrics([])
      } catch {
        if (!cancelled) setLyrics([])
      }
    }

    fetchLyrics()
    return () => {
      cancelled = true
    }
  }, [session?.title, session?.artist, session?.thumb, session?.source, widget.customLrc, widget.autoFetchYoutubeCaptions, widget.youtubeVideoId])

  // Track active lyric line
  useEffect(() => {
    if (lyrics.length === 0) return
    let idx = 0
    for (let i = 0; i < lyrics.length; i++) {
      const line = lyrics[i]
      if (line && line.time <= playbackPos) idx = i
      else break
    }
    setActiveLyricIdx(idx)

    const c = lyricsContainerRef.current
    if (c) {
      const activeEl = c.children[idx] as HTMLElement | undefined
      if (activeEl) {
        c.scrollTo({
          top: activeEl.offsetTop - c.clientHeight / 2 + activeEl.clientHeight / 2,
          behavior: 'smooth',
        })
      }
    }
  }, [playbackPos, lyrics])

  const isLikelyPlaceholder = Boolean(session?.thumb && session.thumb.length < 3500)
  const resolvedThumb = (!isLikelyPlaceholder && session?.thumb && session.thumb.length > 0 ? session.thumb : (discoveredThumb || session?.thumb)) || ''

  const np = session ?? {
    hasSession: true,
    title: currentMock.title,
    artist: currentMock.artist,
    playing: isPlaying,
    thumb: currentMock.thumb,
    source: currentMock.source,
    position: 0,
    duration: currentMock.duration,
  }
  const artRgb = useArtColor(resolvedThumb || np.thumb)
  const volume = vol

  const visualizerTheme = widget.visualizerTheme || 'songAdaptive'
  let visualizerColor = 'var(--accent)'
  if (visualizerTheme === 'songAdaptive') {
    visualizerColor = artRgb || wallpaperAccent || 'var(--accent)'
  } else if (visualizerTheme === 'wallpaper') {
    visualizerColor = wallpaperAccent || 'var(--accent)'
  } else if (visualizerTheme === 'white') {
    visualizerColor = '#ffffff'
  } else if (visualizerTheme === 'cyan') {
    visualizerColor = '#38bdf8'
  } else if (visualizerTheme === 'orange') {
    visualizerColor = '#f97316'
  }

  // Track BPM for hardware-accelerated beat animations
  const trackBpm = getTrackBpm(np.title, np.artist)
  const [userBeatOffset, setUserBeatOffset] = useState<number>(0)
  const trackBeatOffset = getTrackBeatOffset(np.title, np.artist)
  const totalBeatOffset = userBeatOffset !== 0 ? userBeatOffset : trackBeatOffset

  const handleTapBeatSync = () => {
    const beatSec = 60 / trackBpm
    const currentPhase = (playbackPos % beatSec + beatSec) % beatSec
    setUserBeatOffset(currentPhase)
  }

  const changeVolume = (val: number) => {
    setVol(val)
    if (isTauri()) setVolume(val).catch(() => {})
  }

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isTauri()) {
      mediaControl('playpause').catch(() => {})
    } else {
      setIsPlaying((prev) => !prev)
      setSession((prev) => (prev ? { ...prev, playing: !prev.playing } : null))
    }
  }

  const prevTrack = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isTauri()) {
      mediaControl('prev').catch(() => {})
    } else {
      setMockIndex((prev) => (prev - 1 + MOCK_PLAYLIST.length) % MOCK_PLAYLIST.length)
    }
  }

  const nextTrack = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isTauri()) {
      mediaControl('next').catch(() => {})
    } else {
      setMockIndex((prev) => (prev + 1) % MOCK_PLAYLIST.length)
    }
  }

  const handleSeek = (time: number) => {
    lastSeekTimeRef.current = performance.now()
    lastSyncRef.current = {
      pos: time,
      time: performance.now(),
      playing: session?.playing ?? isPlaying,
    }
    setLivePos(time)
    if (isTauri()) {
      mediaSeek(time).catch(() => {})
    }
  }

  // Outer container styling
  let containerBg = 'bg-[var(--surface)]/80 backdrop-blur-md border border-[var(--border)] shadow-lg'
  if (backgroundStyle === 'solid') {
    containerBg = 'bg-[var(--surface-active)] border border-[var(--border)] shadow-lg'
  } else if (backgroundStyle === 'transparent') {
    containerBg = 'bg-transparent border-0 drop-shadow-md'
  } else if (backgroundStyle === 'cover') {
    containerBg = 'bg-black/85 border border-white/10 shadow-2xl'
  }

  const activeLyric = lyrics[activeLyricIdx]
  const nextLyric = lyrics[activeLyricIdx + 1]
  const arrowIconSize = isLargeButtons ? 24 : 17

  const renderControls = (isCompactHeader = false) => {
    if (controlsLayout === 'hidden') return null
    const iconSize = isCompactHeader ? 14 : arrowIconSize
    const playBtnClass = isCompactHeader
      ? 'flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] shadow-sm hover:scale-105 active:scale-95 transition-transform'
      : isLargeButtons
        ? 'flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] shadow-md hover:scale-105 active:scale-95 transition-transform'
        : 'flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] shadow-md hover:scale-105 active:scale-95 transition-transform'
    const playIconSize = isCompactHeader ? 11 : isLargeButtons ? 20 : 17
    const btnBoxClass = isCompactHeader
      ? 'flex h-6 w-6 items-center justify-center text-white/80 hover:text-white hover:scale-110 active:scale-95 transition-all'
      : isLargeButtons
        ? 'flex h-9 w-9 items-center justify-center text-white/80 hover:text-white hover:scale-110 active:scale-95 transition-all'
        : 'flex h-8 w-8 items-center justify-center text-white/80 hover:text-white hover:scale-110 active:scale-95 transition-all'

    return (
      <div className={`flex shrink-0 items-center ${isCompactHeader ? 'gap-1' : 'gap-2'}`}>
        {showLoop && !isCompactHeader && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              const nextVal = !isLooping
              setIsLooping(nextVal)
              if (isTauri()) {
                mediaRepeat(nextVal).catch(() => {})
              }
            }}
            title="Toggle Loop"
            className={`flex h-8 w-8 items-center justify-center transition-all ${
              isLooping
                ? 'text-[var(--accent)] drop-shadow-[0_0_6px_var(--accent)] scale-110'
                : 'text-[var(--text-tertiary)] hover:text-white'
            }`}
          >
            <Repeat size={14} />
          </button>
        )}

        <button
          type="button"
          onClick={prevTrack}
          aria-label="Previous Track"
          className={btnBoxClass}
        >
          <SkipBack size={iconSize} />
        </button>

        <button
          type="button"
          onClick={togglePlay}
          aria-label={np.playing ? 'Pause' : 'Play'}
          className={playBtnClass}
        >
          {np.playing ? (
            <Pause size={playIconSize} className="fill-current" />
          ) : (
            <Play size={playIconSize} className="ml-0.5 fill-current" />
          )}
        </button>

        <button
          type="button"
          onClick={nextTrack}
          aria-label="Next Track"
          className={btnBoxClass}
        >
          <SkipForward size={iconSize} />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`group relative flex h-full w-full flex-col overflow-hidden rounded-[14px] ${containerBg}`}
    >
      {/* Background artwork glow or Full Bleed Cover */}
      <AnimatePresence>
        {(backgroundStyle === 'cover' || artLayout === 'cover') && !!np.thumb && (
          <motion.div
            key={`cover-${np.thumb}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
            className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]"
          >
            <img
              src={np.thumb}
              alt=""
              className="w-full h-full object-cover object-center scale-105 filter blur-[0.6px]"
            />
            {/* Rich cinematic gradient scrim over cover so text & controls remain 100% readable */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/92 via-black/55 to-black/35 backdrop-blur-[1px]" />
          </motion.div>
        )}
        {backgroundStyle !== 'cover' && artLayout !== 'cover' && artBackground && !!np.thumb && backgroundStyle !== 'transparent' && (
          <motion.div
            key={np.thumb}
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.28 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="pointer-events-none absolute inset-0 bg-cover bg-center"
            style={{
              backgroundImage: `url(${np.thumb})`,
              filter: 'blur(36px) saturate(1.4)',
              transform: 'scale(1.25)',
            }}
          />
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className={`relative z-10 flex min-h-0 flex-1 flex-col ${paddingClass}`}>
      {/* Hardware-accelerated dynamic beat bounce & spinning vinyl keyframes */}
      <style>{`
        @keyframes beatThumbBounce {
          0% { transform: scale(1.05); }
          30% { transform: scale(1.0); }
          100% { transform: scale(1.0); }
        }
        @keyframes beatRingPulse {
          0% { transform: scale(0.96); opacity: 0.95; }
          45% { transform: scale(1.08); opacity: 0.25; }
          100% { transform: scale(1.14); opacity: 0; }
        }
        @keyframes subwooferPump {
          0% { transform: scale(1.0); }
          18% { transform: scale(1.09); }
          36% { transform: scale(0.97); }
          56% { transform: scale(1.03); }
          78% { transform: scale(0.99); }
          100% { transform: scale(1.0); }
        }
        @keyframes spinDisc {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes spinTurntableDisc {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes marqueeScrollText {
          0%, 15% { transform: translateX(0%); }
          85%, 100% { transform: translateX(calc(-100% + 140px)); }
        }
        .animate-marquee-text {
          display: inline-block;
          white-space: nowrap;
          animation: marqueeScrollText 7s ease-in-out infinite alternate;
        }
      `}</style>

        {/* Top Header */}
        <div className={`mb-1.5 flex shrink-0 items-center justify-between ${!showSourceHeader ? 'justify-end' : ''}`}>
          {showSourceHeader && (
            <HudElementWrapper
              elementKey="source"
              label="App Header"
              hudLayout={hudLayout}
              hudEditMode={hudEditMode}
              selectedElement={hudSelectedElement}
              onSelect={handleHudSelect}
              onMove={handleHudMove}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                <Music size={12} className="text-[var(--accent)]" />
                <span className="truncate max-w-[130px]">{sourceName(np.source) || 'Player'}</span>
              </div>
            </HudElementWrapper>
          )}

          <div className="flex items-center gap-2">
            {controlsLayout === 'top-right' && (
              <HudElementWrapper
                elementKey="controls"
                label="Controls"
                hudLayout={hudLayout}
                hudEditMode={hudEditMode}
                selectedElement={hudSelectedElement}
                onSelect={handleHudSelect}
                onMove={handleHudMove}
              >
                {renderControls(true)}
              </HudElementWrapper>
            )}
            {volumeStyle === 'hover' && volume >= 0 && (
              <HudElementWrapper
                elementKey="volume"
                label="Volume"
                hudLayout={hudLayout}
                hudEditMode={hudEditMode}
                selectedElement={hudSelectedElement}
                onSelect={handleHudSelect}
                onMove={handleHudMove}
              >
                <VolumeHover value={volume} onChange={changeVolume} />
              </HudElementWrapper>
            )}
            {lyricsStyle !== 'off' && widget.showKaraokeButton !== false && (
              <HudElementWrapper
                elementKey="karaoke"
                label="Mic Button"
                hudLayout={hudLayout}
                hudEditMode={hudEditMode}
                selectedElement={hudSelectedElement}
                onSelect={handleHudSelect}
                onMove={handleHudMove}
              >
                <Tooltip label={isKaraokeOpen ? 'Exit Karaoke' : 'Full Synced Lyrics'}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setIsKaraokeOpen((prev) => !prev)
                    }}
                    className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                      isKaraokeOpen
                        ? 'text-[var(--accent)] bg-white/10'
                        : 'text-[var(--text-tertiary)] hover:text-white hover:bg-white/10'
                    }`}
                  >
                    <Mic2 size={13} />
                  </button>
                </Tooltip>
              </HudElementWrapper>
            )}
          </div>
        </div>

        {/* ── FULL SYNCED KARAOKE VIEW ── */}
        {isKaraokeOpen ? (
          <div className="relative flex min-h-0 flex-1 flex-col justify-between overflow-hidden">
            {visualizerType !== 'none' && (
              <div className="absolute inset-x-0 bottom-12 h-14 opacity-25 pointer-events-none">
                <VisualizerCanvas
                  type={visualizerType}
                  playing={np.playing}
                  color={visualizerColor}
                  playbackPos={playbackPos}
                  title={np.title}
                  artist={np.artist}
                />
              </div>
            )}

            <div
              ref={lyricsContainerRef}
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-4 text-center scrollbar-none"
              style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)' }}
            >
              {lyrics.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-xs text-[var(--text-tertiary)]">
                  <Mic2 size={24} className="opacity-40 mb-1" />
                  <span className="font-semibold text-white/80">No Synced Lyrics Found</span>
                  <p className="text-[11px] max-w-[240px] text-white/50 leading-relaxed">
                    For podcasts or YouTube videos, paste any transcript (SRT, VTT, LRC) or chapters in Settings.
                  </p>
                </div>
              ) : (
                lyrics.map((line, idx) => {
                  const isActive = idx === activeLyricIdx
                  return (
                    <p
                      key={idx}
                      style={getLyricsStyle(lyricsStyle, isActive, artRgb, wallpaperAccent)}
                      onClick={() => handleSeek(line.time)}
                      className={`transition-all duration-300 select-none cursor-pointer ${
                        isActive ? 'scale-105' : 'hover:opacity-75'
                      }`}
                    >
                      {line.text}
                    </p>
                  )
                })
              )}
            </div>

            {/* Karaoke Footer Media Controls */}
            <div className="mt-1 flex shrink-0 flex-col gap-1 border-t border-white/10 pt-1.5">
              {np.duration > 0 && progressBarStyle !== 'hidden' && (
                <ProgressBar
                  position={playbackPos}
                  duration={np.duration}
                  mode={progressBarStyle}
                  onSeek={handleSeek}
                />
              )}
              <div className="flex items-center justify-between pt-0.5">
                <span className="truncate text-[11px] font-bold text-white/90 max-w-[140px]">
                  {np.title}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={prevTrack}
                    className="flex h-7 w-7 items-center justify-center text-white/80 hover:text-white"
                  >
                    <SkipBack size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)]"
                  >
                    {np.playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={nextTrack}
                    className="flex h-7 w-7 items-center justify-center text-white/80 hover:text-white"
                  >
                    <SkipForward size={16} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── STANDARD VIEWS (HERO, SPLIT, COMPACT LEFT/RIGHT) ── */
          <div className={`flex min-h-0 flex-1 flex-col justify-between overflow-hidden ${gapClass}`}>
            {/* 50/50 SPLIT HI-FI DUAL-COLUMN LAYOUT */}
            {artLayout === 'split' ? (
              <div className="flex min-h-0 flex-1 items-center gap-3.5 overflow-hidden py-1">
                {np.thumb && (
                  <HudElementWrapper
                    elementKey="artwork"
                    label="Artwork"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                    className="relative flex h-full max-h-full aspect-square shrink-0 items-center justify-center overflow-hidden"
                  >
                    <ArtworkRenderer
                      thumb={resolvedThumb}
                      title={np.title}
                      design={artDesign}
                      isHero
                      adaptiveRatio={adaptiveArtRatio}
                      liveAudioPeakRef={liveAudioPeakRef}
                      playing={np.playing}
                      visualizerType={visualizerType}
                      visualizerColor={visualizerColor}
                      trackBpm={trackBpm}
                      playbackPos={playbackPos}
                      beatOffset={totalBeatOffset}
                      onTapBeatSync={handleTapBeatSync}
                    />
                  </HudElementWrapper>
                )}

                <div className="flex min-w-0 flex-1 flex-col justify-between h-full py-0.5 gap-1.5 overflow-hidden">
                  <HudElementWrapper
                    elementKey="info"
                    label="Track Info"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                  >
                    <TrackInfo
                      title={np.title || t('nowplaying.unknownTrack')}
                      artist={np.artist || ''}
                      source={np.source}
                      alignment={infoAlignment}
                      typography={infoTypography}
                      density={infoDensity}
                      showArtist={showArtist}
                      marquee={marqueeScroll}
                      titleSize={titleFontSize}
                      artistSize={artistFontSize}
                      lyricsStyle={lyricsStyle}
                      activeLyric={activeLyric}
                      nextLyric={nextLyric}
                      artRgb={artRgb}
                      wallpaperAccent={wallpaperAccent}
                      hudLayout={hudLayout}
                      hudEditMode={hudEditMode}
                      selectedElement={hudSelectedElement}
                      onHudSelect={handleHudSelect}
                      onHudMove={handleHudMove}
                    />
                  </HudElementWrapper>

                  {visualizerType !== 'none' && visualizerType !== 'halo' && (
                    <HudElementWrapper
                      elementKey="visualizer"
                      label="Visualizer"
                      hudLayout={hudLayout}
                      hudEditMode={hudEditMode}
                      selectedElement={hudSelectedElement}
                      onSelect={handleHudSelect}
                      onMove={handleHudMove}
                      className="min-h-[26px] h-6 w-full shrink-0 px-1 opacity-95"
                    >
                      <VisualizerCanvas
                        type={visualizerType}
                        playing={np.playing}
                        color={visualizerColor}
                        playbackPos={playbackPos}
                        title={np.title}
                        artist={np.artist}
                      />
                    </HudElementWrapper>
                  )}

                  {np.duration > 0 && progressBarStyle !== 'hidden' && (
                    <HudElementWrapper
                      elementKey="scrubber"
                      label="Scrubber"
                      hudLayout={hudLayout}
                      hudEditMode={hudEditMode}
                      selectedElement={hudSelectedElement}
                      onSelect={handleHudSelect}
                      onMove={handleHudMove}
                      className="w-full shrink-0"
                    >
                      <ProgressBar
                        position={playbackPos}
                        duration={np.duration}
                        mode={progressBarStyle}
                        onSeek={handleSeek}
                      />
                    </HudElementWrapper>
                  )}
                </div>
              </div>
            ) : artLayout === 'hero' ? (
              /* HERO TOP SHOWCASE LAYOUT */
              <div className="flex min-h-0 flex-1 flex-col items-center justify-between gap-2 overflow-hidden py-1">
                {np.thumb && (
                  <HudElementWrapper
                    elementKey="artwork"
                    label="Artwork"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                    className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden w-full py-1"
                  >
                    <ArtworkRenderer
                      thumb={np.thumb}
                      title={np.title}
                      design={artDesign}
                      isHero
                      adaptiveRatio={adaptiveArtRatio}
                      playing={np.playing}
                      visualizerType={visualizerType}
                      visualizerColor={visualizerColor}
                      trackBpm={trackBpm}
                      playbackPos={playbackPos}
                      beatOffset={totalBeatOffset}
                      onTapBeatSync={handleTapBeatSync}
                    />
                  </HudElementWrapper>
                )}

                <HudElementWrapper
                  elementKey="info"
                  label="Track Info"
                  hudLayout={hudLayout}
                  hudEditMode={hudEditMode}
                  selectedElement={hudSelectedElement}
                  onSelect={handleHudSelect}
                  onMove={handleHudMove}
                  className="w-full shrink-0 px-1"
                >
                  <TrackInfo
                    title={np.title || t('nowplaying.unknownTrack')}
                    artist={np.artist || ''}
                    source={np.source}
                    alignment={infoAlignment}
                    typography={infoTypography}
                    density={infoDensity}
                    showArtist={showArtist}
                    marquee={marqueeScroll}
                    titleSize={Math.round(titleFontSize * 1.05)}
                    artistSize={artistFontSize}
                    lyricsStyle={lyricsStyle}
                    activeLyric={activeLyric}
                    nextLyric={nextLyric}
                    artRgb={artRgb}
                    wallpaperAccent={wallpaperAccent}
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onHudSelect={handleHudSelect}
                    onHudMove={handleHudMove}
                  />
                </HudElementWrapper>

                {visualizerType !== 'none' && visualizerType !== 'halo' && (
                  <HudElementWrapper
                    elementKey="visualizer"
                    label="Visualizer"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                    className="min-h-[44px] h-11 w-full shrink-0 px-2 opacity-95 my-1"
                  >
                    <VisualizerCanvas
                      type={visualizerType}
                      playing={np.playing}
                      color={visualizerColor}
                      playbackPos={playbackPos}
                      title={np.title}
                      artist={np.artist}
                    />
                  </HudElementWrapper>
                )}

                {np.duration > 0 && progressBarStyle !== 'hidden' && (
                  <HudElementWrapper
                    elementKey="scrubber"
                    label="Scrubber"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                    className="w-full shrink-0 px-1"
                  >
                    <ProgressBar
                      position={playbackPos}
                      duration={np.duration}
                      mode={progressBarStyle}
                      onSeek={handleSeek}
                    />
                  </HudElementWrapper>
                )}
              </div>
            ) : (
              /* COMPACT (LEFT OR RIGHT OR HIDDEN) */
              <div className="flex min-h-0 flex-1 flex-col justify-center gap-1.5 overflow-hidden">
                <div
                  className={`flex min-h-0 flex-1 items-center gap-3.5 overflow-hidden ${
                    artLayout === 'right' ? 'flex-row-reverse' : 'flex-row'
                  }`}
                >
                  {artLayout !== 'hidden' && (
                    <HudElementWrapper
                      elementKey="artwork"
                      label="Artwork"
                      hudLayout={hudLayout}
                      hudEditMode={hudEditMode}
                      selectedElement={hudSelectedElement}
                      onSelect={handleHudSelect}
                      onMove={handleHudMove}
                      className="shrink-0"
                    >
                      <ArtworkRenderer
                        thumb={resolvedThumb}
                        title={np.title}
                        design={artDesign}
                        size={fluidThumbSize}
                        adaptiveRatio={adaptiveArtRatio}
                        liveAudioPeakRef={liveAudioPeakRef}
                        playing={np.playing}
                        visualizerType={visualizerType}
                        visualizerColor={visualizerColor}
                        trackBpm={trackBpm}
                        playbackPos={playbackPos}
                        beatOffset={totalBeatOffset}
                        onTapBeatSync={handleTapBeatSync}
                      />
                    </HudElementWrapper>
                  )}

                  <HudElementWrapper
                    elementKey="info"
                    label="Track Info"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                    className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden"
                  >
                    <TrackInfo
                      title={np.title || t('nowplaying.unknownTrack')}
                      artist={np.artist || ''}
                      source={np.source}
                      alignment={infoAlignment}
                      typography={infoTypography}
                      density={infoDensity}
                      showArtist={showArtist}
                      marquee={marqueeScroll}
                      titleSize={titleFontSize}
                      artistSize={artistFontSize}
                      lyricsStyle={lyricsStyle}
                      activeLyric={activeLyric}
                      nextLyric={nextLyric}
                      artRgb={artRgb}
                      wallpaperAccent={wallpaperAccent}
                      hudLayout={hudLayout}
                      hudEditMode={hudEditMode}
                      selectedElement={hudSelectedElement}
                      onHudSelect={handleHudSelect}
                      onHudMove={handleHudMove}
                    />
                  </HudElementWrapper>
                </div>

                {/* ── Dedicated Beat Visualizer (Visible regardless of lyrics!) ── */}
                {visualizerType !== 'none' && visualizerType !== 'halo' && (
                  <HudElementWrapper
                    elementKey="visualizer"
                    label="Visualizer"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                    className="min-h-[28px] h-7 w-full shrink-0 px-1 opacity-95 my-0.5"
                  >
                    <VisualizerCanvas
                      type={visualizerType}
                      playing={np.playing}
                      color={visualizerColor}
                      playbackPos={playbackPos}
                      title={np.title}
                      artist={np.artist}
                    />
                  </HudElementWrapper>
                )}

                {np.duration > 0 && progressBarStyle !== 'hidden' && (
                  <HudElementWrapper
                    elementKey="scrubber"
                    label="Scrubber"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                  >
                    <ProgressBar
                      position={playbackPos}
                      duration={np.duration}
                      mode={progressBarStyle}
                      onSeek={handleSeek}
                    />
                  </HudElementWrapper>
                )}
              </div>
            )}

            {/* ── CONTROLS ROW ── */}
            {controlsLayout === 'bottom-center' ? (
              <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
                <div className="flex-1 flex justify-start">
                  {volumeStyle !== 'hover' && volumeStyle !== 'hidden' && volume >= 0 && (
                    <HudElementWrapper
                      elementKey="volume"
                      label="Volume"
                      hudLayout={hudLayout}
                      hudEditMode={hudEditMode}
                      selectedElement={hudSelectedElement}
                      onSelect={handleHudSelect}
                      onMove={handleHudMove}
                    >
                      <VolumeControl style={volumeStyle} value={volume} onChange={changeVolume} />
                    </HudElementWrapper>
                  )}
                </div>
                <div className="flex shrink-0 justify-center">
                  <HudElementWrapper
                    elementKey="controls"
                    label="Controls"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                  >
                    {renderControls()}
                  </HudElementWrapper>
                </div>
                <div className="flex-1" />
              </div>
            ) : controlsLayout === 'bottom-left' ? (
              <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
                <HudElementWrapper
                  elementKey="controls"
                  label="Controls"
                  hudLayout={hudLayout}
                  hudEditMode={hudEditMode}
                  selectedElement={hudSelectedElement}
                  onSelect={handleHudSelect}
                  onMove={handleHudMove}
                >
                  {renderControls()}
                </HudElementWrapper>
                {volumeStyle !== 'hover' && volumeStyle !== 'hidden' && volume >= 0 ? (
                  <div className="flex-1 flex justify-end">
                    <HudElementWrapper
                      elementKey="volume"
                      label="Volume"
                      hudLayout={hudLayout}
                      hudEditMode={hudEditMode}
                      selectedElement={hudSelectedElement}
                      onSelect={handleHudSelect}
                      onMove={handleHudMove}
                    >
                      <VolumeControl style={volumeStyle} value={volume} onChange={changeVolume} />
                    </HudElementWrapper>
                  </div>
                ) : (
                  <div className="flex-1" />
                )}
              </div>
            ) : controlsLayout === 'bottom-right' ? (
              <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
                {volumeStyle !== 'hover' && volumeStyle !== 'hidden' && volume >= 0 ? (
                  <HudElementWrapper
                    elementKey="volume"
                    label="Volume"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                  >
                    <VolumeControl style={volumeStyle} value={volume} onChange={changeVolume} />
                  </HudElementWrapper>
                ) : (
                  <div className="flex-1" />
                )}
                <HudElementWrapper
                  elementKey="controls"
                  label="Controls"
                  hudLayout={hudLayout}
                  hudEditMode={hudEditMode}
                  selectedElement={hudSelectedElement}
                  onSelect={handleHudSelect}
                  onMove={handleHudMove}
                >
                  {renderControls()}
                </HudElementWrapper>
              </div>
            ) : (
              volumeStyle !== 'hover' && volumeStyle !== 'hidden' && volume >= 0 ? (
                <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
                  <HudElementWrapper
                    elementKey="volume"
                    label="Volume"
                    hudLayout={hudLayout}
                    hudEditMode={hudEditMode}
                    selectedElement={hudSelectedElement}
                    onSelect={handleHudSelect}
                    onMove={handleHudMove}
                  >
                    <VolumeControl style={volumeStyle} value={volume} onChange={changeVolume} />
                  </HudElementWrapper>
                  <div className="flex-1" />
                </div>
              ) : null
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Clean, Compact, Non-Duplicated Settings Panel ──
export function NowPlayingSettings({
  widget,
  onUpdate,
}: {
  widget: NowPlayingWidgetType
  onUpdate: (patch: Partial<NowPlayingWidgetType>) => void
}) {
  const { t } = useTranslation()
  const preset = widget.preset || 'compact'

  const applyPreset = (key: string) => {
    const config = PRESET_CONFIGS[key] || { preset: key as any }
    onUpdate(config)
  }

  // Active element visibility states
  const isArtEnabled = widget.artLayout !== 'hidden'
  const isInfoEnabled = widget.infoDensity !== 'hidden'
  const isControlsEnabled = widget.controlsLayout !== 'hidden'
  const isScrubberEnabled = widget.progressBarStyle !== 'hidden'
  const isVolumeEnabled = widget.volumeStyle !== 'hidden'
  const isVisualizerEnabled = widget.visualizerType !== 'none' && !!widget.visualizerType
  const isLyricsEnabled = widget.lyricsStyle !== 'off' && !!widget.lyricsStyle

  return (
    <div className="flex w-[285px] flex-col gap-2.5 select-none text-[13px]">
      {/* ── Surface & Appearance (Global Card) ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
          Surface & Appearance
        </span>
        <FieldRow label="Widget Preset">
          <Select
            value={preset}
            options={[
              { value: 'compact', label: 'Compact Card' },
              { value: 'hero', label: 'Hero Big Art' },
              { value: 'classic', label: 'Layer Dial Knob' },
              { value: 'transparent', label: 'Floating Transparent' },
              { value: 'custom', label: 'Custom' },
            ]}
            onChange={applyPreset}
          />
        </FieldRow>

        <FieldRow label="Card Surface">
          <Select
            value={widget.backgroundStyle || (preset === 'transparent' ? 'transparent' : 'glass')}
            options={[
              { value: 'glass', label: 'Frosted Glass' },
              { value: 'solid', label: 'Solid Surface' },
              { value: 'transparent', label: 'Floating Transparent' },
              { value: 'cover', label: 'Full Bleed Album Cover' },
            ]}
            onChange={(v) => onUpdate({ backgroundStyle: v as any, preset: 'custom' })}
          />
        </FieldRow>

        <FieldRow label="Layout Sizing">
          <Select
            value={widget.layoutSizing || 'fluid'}
            options={[
              { value: 'fluid', label: 'Fluid Dynamic (Responsive)' },
              { value: 'fixed', label: 'Fixed Classic Size' },
            ]}
            onChange={(v) => onUpdate({ layoutSizing: v as any, preset: 'custom' })}
          />
        </FieldRow>

        <FieldRow label={t('nowplaying.settings.artBackground', 'Ambient Cover Glow')}>
          <Toggle
            checked={widget.artBackground !== false}
            onChange={(v) => onUpdate({ artBackground: v, preset: 'custom' })}
          />
        </FieldRow>

        <FieldRow label="Card Padding">
          <Select
            value={widget.cardPadding || 'normal'}
            options={[
              { value: 'compact', label: 'Compact Inset (8px)' },
              { value: 'normal', label: 'Default Inset (14px)' },
              { value: 'relaxed', label: 'Spacious Inset (20px)' },
            ]}
            onChange={(v) => onUpdate({ cardPadding: v as any, preset: 'custom' })}
          />
        </FieldRow>

        <FieldRow label="Element Gap">
          <Select
            value={widget.elementGap || 'normal'}
            options={[
              { value: 'tight', label: 'Tight Spacing (4px)' },
              { value: 'normal', label: 'Balanced Spacing (6px)' },
              { value: 'relaxed', label: 'Relaxed Spacing (10px)' },
            ]}
            onChange={(v) => onUpdate({ elementGap: v as any, preset: 'custom' })}
          />
        </FieldRow>
      </div>

      {/* ── 1. Album Artwork ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Album Artwork">
          <Toggle
            checked={isArtEnabled}
            onChange={(v) =>
              onUpdate({
                artLayout: v ? (preset === 'hero' ? 'hero' : 'left') : 'hidden',
                preset: 'custom',
              })
            }
          />
        </FieldRow>

        {isArtEnabled && (
          <div className="flex flex-col gap-2 pl-2 border-l border-white/15 ml-1 pt-0.5">
            <FieldRow label="Layout">
              <Select
                value={widget.artLayout && widget.artLayout !== 'hidden' ? widget.artLayout : (preset === 'hero' ? 'hero' : 'left')}
                options={[
                  { value: 'left', label: 'Left Thumbnail' },
                  { value: 'right', label: 'Right Thumbnail' },
                  { value: 'hero', label: 'Hero Big Art (Top Showcase)' },
                  { value: 'split', label: '50/50 Split Hi-Fi' },
                ]}
                onChange={(v) => onUpdate({ artLayout: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Design Shape">
              <Select
                value={widget.artDesign || 'square'}
                options={[
                  { value: 'square', label: 'Classic Square Cover' },
                  { value: 'circle', label: 'Circular Disc' },
                  { value: 'cd', label: 'Rotating Vinyl / CD' },
                  { value: 'turntable', label: '2D Turntable (Vinyl & Arm)' },
                ]}
                onChange={(v) => onUpdate({ artDesign: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Adaptive Ratio (16:9)">
              <Toggle
                checked={widget.adaptiveArtRatio === true}
                onChange={(v) => onUpdate({ adaptiveArtRatio: v, preset: 'custom' })}
              />
            </FieldRow>
          </div>
        )}
      </div>

      {/* ── 2. Track Info & Detail ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Track Info Detail">
          <Toggle
            checked={isInfoEnabled}
            onChange={(v) =>
              onUpdate({
                infoDensity: v ? 'stacked' : 'hidden',
                preset: 'custom',
              })
            }
          />
        </FieldRow>

        {isInfoEnabled && (
          <div className="flex flex-col gap-2 pl-2 border-l border-white/15 ml-1 pt-0.5">
            <FieldRow label="Alignment">
              <Select
                value={widget.infoAlignment || (widget.artLayout === 'hero' ? 'center' : 'left')}
                options={[
                  { value: 'left', label: 'Left Aligned' },
                  { value: 'center', label: 'Center Aligned' },
                  { value: 'right', label: 'Right Aligned' },
                ]}
                onChange={(v) => onUpdate({ infoAlignment: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Typography">
              <Select
                value={widget.infoTypography || 'modern'}
                options={[
                  { value: 'modern', label: 'Modern Bold Sans' },
                  { value: 'mono', label: 'Cyber Monospace / Tech' },
                  { value: 'serif', label: 'Vintage Editorial Serif' },
                  { value: 'allcaps', label: 'Sleek All-Caps' },
                ]}
                onChange={(v) => onUpdate({ infoTypography: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Density">
              <Select
                value={widget.infoDensity && widget.infoDensity !== 'hidden' ? widget.infoDensity : 'stacked'}
                options={[
                  { value: 'stacked', label: 'Stacked (Classic 2-Line)' },
                  { value: 'inline', label: 'Inline (Single Combined Line)' },
                  { value: 'badges', label: 'Badges (With Source Pill)' },
                ]}
                onChange={(v) => onUpdate({ infoDensity: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Show Artist">
              <Toggle
                checked={widget.showArtist !== false}
                onChange={(v) => onUpdate({ showArtist: v, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Marquee Long Titles">
              <Toggle
                checked={widget.marqueeScroll === true}
                onChange={(v) => onUpdate({ marqueeScroll: v, preset: 'custom' })}
              />
            </FieldRow>
          </div>
        )}
      </div>

      {/* ── 3. Playing Source Header (Spotify / Chrome / App) ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Playing Source Header">
          <Toggle
            checked={widget.showSourceHeader !== false}
            onChange={(v) => onUpdate({ showSourceHeader: v, preset: 'custom' })}
          />
        </FieldRow>

        {widget.showSourceHeader !== false && (
          <div className="flex flex-col gap-1 pl-2 border-l border-white/15 ml-1 pt-0.5 text-[11px] text-[var(--text-tertiary)]">
            <span>Shows audio source (Spotify, Chrome, Player) in top-left. Customizable in HUD.</span>
          </div>
        )}
      </div>

      {/* ── 4. Playback Controls (Arrow Glyphs) ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Playback Controls">
          <Toggle
            checked={isControlsEnabled}
            onChange={(v) =>
              onUpdate({
                controlsLayout: v ? (widget.artLayout === 'hero' ? 'bottom-center' : 'bottom-right') : 'hidden',
                preset: 'custom',
              })
            }
          />
        </FieldRow>

        {isControlsEnabled && (
          <div className="flex flex-col gap-2 pl-2 border-l border-white/15 ml-1 pt-0.5">
            <FieldRow label="Placement">
              <Select
                value={widget.controlsLayout && widget.controlsLayout !== 'hidden' ? widget.controlsLayout : 'bottom-right'}
                options={[
                  { value: 'bottom-right', label: 'Bottom Right (Down Corner)' },
                  { value: 'bottom-center', label: 'Bottom Center' },
                  { value: 'bottom-left', label: 'Bottom Left' },
                  { value: 'top-right', label: 'Top Right (Header)' },
                ]}
                onChange={(v) => onUpdate({ controlsLayout: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Arrow Glyph Size">
              <Select
                value={widget.buttonSize || (preset === 'hero' ? 'large' : 'compact')}
                options={[
                  { value: 'large', label: 'Large (24px Glyphs)' },
                  { value: 'compact', label: 'Compact (17px Glyphs)' },
                ]}
                onChange={(v) => onUpdate({ buttonSize: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Loop Button">
              <Toggle
                checked={widget.showLoop === true}
                onChange={(v) => onUpdate({ showLoop: v, preset: 'custom' })}
              />
            </FieldRow>
          </div>
        )}
      </div>

      {/* ── 5. Timeline Progress Scrubber ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Timeline Scrubber">
          <Toggle
            checked={isScrubberEnabled}
            onChange={(v) =>
              onUpdate({
                progressBarStyle: v ? 'always' : 'hidden',
                preset: 'custom',
              })
            }
          />
        </FieldRow>

        {isScrubberEnabled && (
          <div className="flex flex-col gap-2 pl-2 border-l border-white/15 ml-1 pt-0.5">
            <FieldRow label="Display Mode">
              <Select
                value={widget.progressBarStyle && widget.progressBarStyle !== 'hidden' ? widget.progressBarStyle : 'always'}
                options={[
                  { value: 'always', label: 'Always Visible' },
                  { value: 'hover', label: 'Show on Hover Only' },
                ]}
                onChange={(v) => onUpdate({ progressBarStyle: v as any, preset: 'custom' })}
              />
            </FieldRow>
          </div>
        )}
      </div>

      {/* ── 6. Volume Control ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Volume Control">
          <Toggle
            checked={isVolumeEnabled}
            onChange={(v) =>
              onUpdate({
                volumeStyle: v ? (preset === 'classic' ? 'knob' : 'hover') : 'hidden',
                preset: 'custom',
              })
            }
          />
        </FieldRow>

        {isVolumeEnabled && (
          <div className="flex flex-col gap-2 pl-2 border-l border-white/15 ml-1 pt-0.5">
            <FieldRow label="Dial & Slider Style">
              <Select
                value={widget.volumeStyle && widget.volumeStyle !== 'hidden' ? widget.volumeStyle : 'hover'}
                options={[
                  { value: 'hover', label: 'Hover Speaker Icon' },
                  { value: 'bar', label: 'Horizontal Slider Bar' },
                  { value: 'knob', label: 'Tactile Rotary Dial Knob' },
                  { value: 'fader', label: 'Studio Hi-Fi Fader' },
                  { value: 'stepped', label: 'Segmented LED Ladder' },
                  { value: 'arc', label: 'Circular Arc Gauge' },
                  { value: 'pill', label: 'Minimalist Number Pill' },
                ]}
                onChange={(v) => onUpdate({ volumeStyle: v as any, preset: 'custom' })}
              />
            </FieldRow>
          </div>
        )}
      </div>

      {/* ── 7. Beat Visualizer ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Beat Visualizer">
          <Toggle
            checked={isVisualizerEnabled}
            onChange={(v) =>
              onUpdate({
                visualizerType: v ? 'bars' : 'none',
                preset: 'custom',
              })
            }
          />
        </FieldRow>

        {isVisualizerEnabled && (
          <div className="flex flex-col gap-2 pl-2 border-l border-white/15 ml-1 pt-0.5">
            <FieldRow label="Visualizer Style">
              <Select
                value={widget.visualizerType && widget.visualizerType !== 'none' ? widget.visualizerType : 'bars'}
                options={[
                  { value: 'halo', label: 'Bass Halo (Trap Nation Speaker)' },
                  { value: 'waveform', label: 'Classic Layer Waveform (OG)' },
                  { value: 'bars', label: 'Equalizer Spectrum Bars' },
                  { value: 'wave', label: 'Neon Fluid Wave' },
                  { value: 'radial', label: 'Monstercat Horizon' },
                  { value: 'vu', label: 'Retro Analog VU Meter' },
                  { value: 'plasma', label: 'Liquid Fire Plasma' },
                  { value: 'pulse', label: 'Beat Pulse Shockwave' },
                  { value: 'dots', label: 'Cyber Soundwave Dots' },
                ]}
                onChange={(v) => onUpdate({ visualizerType: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Color Theme">
              <Select
                value={widget.visualizerTheme || 'songAdaptive'}
                options={[
                  { value: 'songAdaptive', label: 'Song Adaptive (Album Art)' },
                  { value: 'wallpaper', label: 'PC Wallpaper Adaptive' },
                  { value: 'accent', label: 'Layer Accent Color' },
                  { value: 'white', label: 'Monochrome Solid White' },
                  { value: 'cyan', label: 'Cyber Neon Cyan' },
                  { value: 'orange', label: 'Magma Flame Orange' },
                ]}
                onChange={(v) => onUpdate({ visualizerTheme: v as any, preset: 'custom' })}
              />
            </FieldRow>
          </div>
        )}
      </div>

      {/* ── 8. Synced Lyrics ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <FieldRow label="Synced Lyrics">
          <Toggle
            checked={isLyricsEnabled}
            onChange={(v) =>
              onUpdate({
                lyricsStyle: v ? 'venom' : 'off',
                preset: 'custom',
              })
            }
          />
        </FieldRow>

        {isLyricsEnabled && (
          <div className="flex flex-col gap-2 pl-2 border-l border-white/15 ml-1 pt-0.5">
            <FieldRow label="Lyrics Theme">
              <Select
                value={widget.lyricsStyle && widget.lyricsStyle !== 'off' ? widget.lyricsStyle : 'venom'}
                options={[
                  { value: 'venom', label: 'Venom B&W Symbiote' },
                  { value: 'chrome', label: 'Liquid Silver Chrome' },
                  { value: 'neon', label: 'Cyber Electric Neon' },
                  { value: 'fire', label: 'Molten Magma Ember' },
                  { value: 'clean', label: 'Clean Solid White' },
                  { value: 'songAdaptive', label: 'Song Adaptive (Artwork)' },
                  { value: 'wallpaper', label: 'PC Wallpaper Adaptive' },
                ]}
                onChange={(v) => onUpdate({ lyricsStyle: v as any, preset: 'custom' })}
              />
            </FieldRow>

            <FieldRow label="Karaoke Button (Mic)">
              <Toggle
                checked={widget.showKaraokeButton !== false}
                onChange={(v) => onUpdate({ showKaraokeButton: v, preset: 'custom' })}
              />
            </FieldRow>

            {/* Custom Transcript / LRC for Podcasts & YouTube */}
            <div className="flex flex-col gap-1.5 pt-1.5 border-t border-white/10">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Podcast & Custom Transcript
                </span>
                {widget.customLrc && (
                  <button
                    type="button"
                    onClick={() => onUpdate({ customLrc: undefined, preset: 'custom' })}
                    className="text-rose-400 hover:text-rose-300 text-[9px] font-semibold"
                  >
                    Clear Custom
                  </button>
                )}
              </div>
              <textarea
                rows={3}
                placeholder="Paste LRC, WebVTT/SRT, or YouTube chapters (00:00 Intro)..."
                value={widget.customLrc || ''}
                onChange={(e) => onUpdate({ customLrc: e.target.value, preset: 'custom' })}
                className="w-full rounded border border-white/10 bg-black/40 p-1.5 text-[10.5px] font-mono text-white/90 placeholder-white/30 focus:border-cyan-400 focus:outline-none resize-none scrollbar-none"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText()
                      if (text) onUpdate({ customLrc: text, preset: 'custom' })
                    } catch {}
                  }}
                  className="flex-1 rounded border border-white/10 bg-white/5 py-1 text-center text-[10px] font-semibold text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                >
                  📋 Paste from Clipboard
                </button>
              </div>
            </div>

            {/* Automated YouTube Video Captions */}
            <div className="flex flex-col gap-1.5 pt-1.5 border-t border-white/10">
              <FieldRow label="Auto YouTube Captions">
                <Toggle
                  checked={widget.autoFetchYoutubeCaptions !== false}
                  onChange={(v) => onUpdate({ autoFetchYoutubeCaptions: v, preset: 'custom' })}
                />
              </FieldRow>

              <div className="flex flex-col gap-1 mt-0.5">
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  Video URL or ID override:
                </span>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    placeholder="https://youtu.be/... or 11-char ID"
                    value={widget.youtubeVideoId || ''}
                    onChange={(e) => {
                      const id = extractYouTubeVideoId(e.target.value) || e.target.value.trim()
                      onUpdate({ youtubeVideoId: id || undefined, preset: 'custom' })
                    }}
                    className="flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-[11px] font-mono text-white/90 placeholder-white/30 focus:border-cyan-400 focus:outline-none"
                  />
                  {widget.youtubeVideoId && (
                    <button
                      type="button"
                      onClick={() => onUpdate({ youtubeVideoId: undefined, preset: 'custom' })}
                      className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/60 hover:text-white"
                      title="Clear Video ID"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── 9. HUD Element Position & Size (Game HUD Style) ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)] flex items-center gap-1.5">
            <Move size={12} className="text-cyan-400" />
            HUD Element Position & Size
          </span>
          <Toggle
            checked={widget.hudEditMode === true}
            onChange={(v) => onUpdate({ hudEditMode: v, preset: 'custom' })}
          />
        </div>

        {widget.hudEditMode && (
          <div className="pt-1.5 border-t border-white/10">
            <ElementHudController
              widget={widget}
              onUpdate={onUpdate}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export const nowPlayingDefinition: WidgetDefinition<NowPlayingWidgetType> = {
  type: 'nowplaying',
  label: 'Now Playing',
  icon: Music,
  enabled: true,
  minSize: { width: 280, height: 170 },
  maxSize: { width: 680, height: 480 },
  styles: [
    { key: 'compact', label: 'Compact Card', patch: PRESET_CONFIGS.compact },
    { key: 'hero', label: 'Hero Big Art', patch: PRESET_CONFIGS.hero },
    { key: 'classic', label: 'Dial Knob', patch: PRESET_CONFIGS.classic },
    { key: 'transparent', label: 'Transparent', patch: PRESET_CONFIGS.transparent },
  ],
  create: (x, y) => ({
    type: 'nowplaying',
    x,
    y,
    width: 380,
    height: 220,
    locked: false,
    artBackground: true,
    preset: 'compact',
    volumeStyle: 'hover',
    artDesign: 'square',
    artLayout: 'left',
    layoutSizing: 'fluid',
    backgroundStyle: 'glass',
    controlsLayout: 'bottom-right',
    buttonSize: 'compact',
    showLoop: false,
    adaptiveArtRatio: false,
    progressBarStyle: 'hover',
    visualizerType: 'none',
    lyricsStyle: 'venom',
    showSourceHeader: true,
    showKaraokeButton: true,
    cardPadding: 'normal',
    elementGap: 'normal',
  }),
  Renderer: NowPlayingRenderer,
  Settings: NowPlayingSettings,
}
