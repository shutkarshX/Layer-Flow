import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useVisibilityStore } from '../store/visibilityStore'
import { isTauri } from '../lib/ipc'

// Global "hide everything" shortcut (default Ctrl+Shift+H, remappable in
// Settings → Shortcuts). Toggles the whole canvas/widgets/top-bar off — handy
// on the go, in public, or before a screenshot/screen-share.
export function useHideAll(): void {
  const toggle = useVisibilityStore((s) => s.toggle)

    useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    if (!isTauri()) {
      return () => window.removeEventListener('keydown', onKeyDown)
    }

    const unlisten = listen('hide-all', () => toggle())
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unlisten.then((fn) => fn()).catch(() => {})
    }
  }, [toggle])
}
