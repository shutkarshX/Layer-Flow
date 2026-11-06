import { useEffect, useRef } from 'react'
import { readText } from '@tauri-apps/plugin-clipboard-manager'
import { useClipboardStore } from '../store/clipboardStore'
import { useVisibilityStore } from '../store/visibilityStore'
import { useCanvasStore } from '../store/canvasStore'
import { isTauri } from '../lib/ipc'

// Polls the OS clipboard for text every 1.5s when active.
// Optimized: skips polling when Layer is in Sleep Mode or when no Clipboard widget is on canvas.
export function useClipboardWatcher(): void {
  const last = useRef('')
  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    const tick = async () => {
      if (!alive) return
      if (!useVisibilityStore.getState().visible) return
      const hasClipboard = useCanvasStore.getState().widgets.some((w) => w.type === 'clipboard')
      if (!hasClipboard) return

      try {
        const text = await readText()
        if (text && text !== last.current) {
          last.current = text
          useClipboardStore.getState().push(text)
        }
      } catch {
        /* ignore — clipboard may briefly be locked by other apps */
      }
    }
    tick()
    const id = window.setInterval(tick, 1500)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])
}
