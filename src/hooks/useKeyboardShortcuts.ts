import { useSettingsStore } from '../store/settingsStore'
import { quitApp } from '../lib/ipc'
import { useEffect } from 'react'
import { useCanvasStore } from '../store/canvasStore'

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA'
  )
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const state = useCanvasStore.getState()

      if (e.key === 'Escape') {
        state.setSelected(null)
        return
      }

      if (isTyping(e.target)) return

      // Global quit shortcut check
      const quitCfg = useSettingsStore.getState().secondaryShortcuts?.quit
      if (quitCfg?.enabled && quitCfg.accelerator) {
        const parts = quitCfg.accelerator.toLowerCase().split('+').map((p) => p.trim())
        const needCtrl = parts.includes('ctrl') || parts.includes('cmdorcontrol') || parts.includes('control')
        const needShift = parts.includes('shift')
        const needAlt = parts.includes('alt')
        const keyPart = parts.find((p) => !['ctrl', 'cmdorcontrol', 'control', 'shift', 'alt', 'super', 'meta'].includes(p))
        const hasCtrl = e.ctrlKey || e.metaKey
        const hasShift = e.shiftKey
        const hasAlt = e.altKey
        const actualKey = (e.key === ' ' ? 'space' : e.key).toLowerCase()
        if (hasCtrl === needCtrl && hasShift === needShift && hasAlt === needAlt && keyPart && actualKey === keyPart) {
          e.preventDefault()
          quitApp().catch(() => {})
          return
        }
      }


      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()

      if (ctrl && k === 'z' && !e.shiftKey) {
        e.preventDefault()
        state.undo()
        return
      }
      if (ctrl && ((k === 'z' && e.shiftKey) || k === 'y')) {
        e.preventDefault()
        state.redo()
        return
      }

      // Ctrl+C / Ctrl+V are deliberately NOT bound to widget copy/paste here.
      // A widget stays "selected" on the canvas even after focus moves away to
      // select text elsewhere (a tooltip, a bookmark title, page text) — so a
      // global Ctrl+C/V binding would hijack ordinary text copy/paste. Cloning
      // a widget is still available via Ctrl+D or the right-click menu.

      const id = state.selectedId
      if (!id) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        state.deleteWidget(id)
      } else if (ctrl && k === 'd') {
        e.preventDefault()
        state.duplicateWidget(id)
      } else if (ctrl && k === ']') {
        e.preventDefault()
        state.bringToFront(id)
      } else if (ctrl && k === '[') {
        e.preventDefault()
        state.sendToBack(id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
