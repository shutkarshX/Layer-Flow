import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Move,
  Settings2,
  RotateCcw,
} from 'lucide-react'
import type { Widget } from '../../types/widget'
import { useCanvasStore } from '../../store/canvasStore'
import { widgetRegistry } from '../../lib/widgetRegistry'
import { cn } from '../../lib/utils'
import { ElementHudController } from './ElementHudController'

export function HudLayoutBox({
  widget,
  onUpdate,
  minSize = { width: 120, height: 80 },
  maxSize,
}: {
  widget: Widget
  onUpdate: (patch: Partial<Widget>) => void
  minSize?: { width: number; height: number }
  maxSize?: { width?: number; height?: number }
}) {
  const [step, setStep] = useState<number>(5)

  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 1080

  const minW = minSize.width
  const maxW = maxSize?.width ?? viewportW
  const minH = minSize.height
  const maxH = maxSize?.height ?? viewportH

  // Nudge movement
  const nudge = (dx: number, dy: number) => {
    const newX = Math.max(0, Math.min(viewportW - widget.width, widget.x + dx))
    const newY = Math.max(0, Math.min(viewportH - widget.height, widget.y + dy))
    onUpdate({ x: newX, y: newY })
  }

  // Center on screen
  const centerScreen = () => {
    const newX = Math.max(0, Math.round((viewportW - widget.width) / 2))
    const newY = Math.max(0, Math.round((viewportH - widget.height) / 2))
    onUpdate({ x: newX, y: newY })
  }

  // Quick snap positions
  const snapTo = (pos: 'tl' | 'tc' | 'tr' | 'cl' | 'cc' | 'cr' | 'bl' | 'bc' | 'br') => {
    const pad = 24
    let x = widget.x
    let y = widget.y

    if (pos.startsWith('t')) y = pad
    if (pos.startsWith('c')) y = Math.max(0, Math.round((viewportH - widget.height) / 2))
    if (pos.startsWith('b')) y = Math.max(0, viewportH - widget.height - pad)

    if (pos.endsWith('l')) x = pad
    if (pos.endsWith('c')) x = Math.max(0, Math.round((viewportW - widget.width) / 2))
    if (pos.endsWith('r')) x = Math.max(0, viewportW - widget.width - pad)

    onUpdate({ x, y })
  }

  // Scale adjustment
  const scaleBy = (multiplier: number) => {
    const newW = Math.max(minW, Math.min(maxW, Math.round(widget.width * multiplier)))
    const newH = Math.max(minH, Math.min(maxH, Math.round(widget.height * multiplier)))
    onUpdate({ width: newW, height: newH })
  }

  return (
    <div className="flex w-[285px] flex-col gap-2.5 select-none text-[13px]">
      {/* ── 1. Precise Nudge D-Pad (Game HUD style) ── */}
      <div className="flex flex-col items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-3">
        <div className="flex w-full items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)] flex items-center gap-1.5">
            <Move size={12} className="text-[var(--accent)]" />
            Precise Nudge (D-Pad)
          </span>
          {/* Step Size Selector */}
          <div className="flex items-center gap-1 rounded bg-black/40 p-0.5 border border-white/10">
            {[1, 5, 25].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStep(s)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-mono font-bold transition-colors',
                  step === s
                    ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                    : 'text-white/60 hover:text-white'
                )}
              >
                {s}px
              </button>
            ))}
          </div>
        </div>

        {/* 3x3 Gaming D-Pad Controller */}
        <div className="relative my-1 flex h-[106px] w-[106px] items-center justify-center rounded-full border border-white/10 bg-black/50 shadow-inner">
          {/* Up */}
          <button
            type="button"
            onClick={() => nudge(0, -step)}
            title={`Nudge Up ${step}px`}
            className="absolute top-1 flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white/90 shadow transition-all hover:bg-[var(--accent)] hover:text-[var(--on-accent)] active:scale-90"
          >
            <ChevronUp size={18} />
          </button>
          {/* Down */}
          <button
            type="button"
            onClick={() => nudge(0, step)}
            title={`Nudge Down ${step}px`}
            className="absolute bottom-1 flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white/90 shadow transition-all hover:bg-[var(--accent)] hover:text-[var(--on-accent)] active:scale-90"
          >
            <ChevronDown size={18} />
          </button>
          {/* Left */}
          <button
            type="button"
            onClick={() => nudge(-step, 0)}
            title={`Nudge Left ${step}px`}
            className="absolute left-1 flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white/90 shadow transition-all hover:bg-[var(--accent)] hover:text-[var(--on-accent)] active:scale-90"
          >
            <ChevronLeft size={18} />
          </button>
          {/* Right */}
          <button
            type="button"
            onClick={() => nudge(step, 0)}
            title={`Nudge Right ${step}px`}
            className="absolute right-1 flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white/90 shadow transition-all hover:bg-[var(--accent)] hover:text-[var(--on-accent)] active:scale-90"
          >
            <ChevronRight size={18} />
          </button>
          {/* Center / Target */}
          <button
            type="button"
            onClick={centerScreen}
            title="Center Widget on Screen"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white/90 transition-all hover:bg-white/30 hover:scale-105 active:scale-95"
          >
            <Crosshair size={14} />
          </button>
        </div>

        {/* Real-time Coordinate Readout */}
        <div className="grid w-full grid-cols-2 gap-2 text-center text-[11px]">
          <div className="flex items-center justify-between rounded-md border border-white/10 bg-black/30 px-2 py-1">
            <span className="text-[var(--text-tertiary)] font-bold">X</span>
            <input
              type="number"
              value={Math.round(widget.x)}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val)) onUpdate({ x: Math.max(0, Math.min(viewportW - widget.width, val)) })
              }}
              className="w-16 bg-transparent text-right font-mono text-white focus:outline-none"
            />
            <span className="text-[var(--text-tertiary)] text-[9px] ml-0.5">px</span>
          </div>

          <div className="flex items-center justify-between rounded-md border border-white/10 bg-black/30 px-2 py-1">
            <span className="text-[var(--text-tertiary)] font-bold">Y</span>
            <input
              type="number"
              value={Math.round(widget.y)}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!isNaN(val)) onUpdate({ y: Math.max(0, Math.min(viewportH - widget.height, val)) })
              }}
              className="w-16 bg-transparent text-right font-mono text-white focus:outline-none"
            />
            <span className="text-[var(--text-tertiary)] text-[9px] ml-0.5">px</span>
          </div>
        </div>
      </div>

      {/* ── 2. Widget Size & Dimensions ── */}
      <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)] flex items-center justify-between">
          <span>Widget Size</span>
          <span className="font-mono text-white/80">{Math.round(widget.width)} × {Math.round(widget.height)}</span>
        </span>

        {/* Width Stepper & Slider */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px] text-white/70">
            <span>Width</span>
            <span className="font-mono">{Math.round(widget.width)}px</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onUpdate({ width: Math.max(minW, widget.width - 10) })}
              className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/80 hover:bg-white/15 active:scale-95"
            >
              -
            </button>
            <input
              type="range"
              min={minW}
              max={maxW}
              step={2}
              value={widget.width}
              onChange={(e) => onUpdate({ width: parseInt(e.target.value, 10) })}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => onUpdate({ width: Math.min(maxW, widget.width + 10) })}
              className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/80 hover:bg-white/15 active:scale-95"
            >
              +
            </button>
          </div>
        </div>

        {/* Height Stepper & Slider */}
        <div className="flex flex-col gap-1 pt-1">
          <div className="flex items-center justify-between text-[11px] text-white/70">
            <span>Height</span>
            <span className="font-mono">{Math.round(widget.height)}px</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onUpdate({ height: Math.max(minH, widget.height - 10) })}
              className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/80 hover:bg-white/15 active:scale-95"
            >
              -
            </button>
            <input
              type="range"
              min={minH}
              max={maxH}
              step={2}
              value={widget.height}
              onChange={(e) => onUpdate({ height: parseInt(e.target.value, 10) })}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => onUpdate({ height: Math.min(maxH, widget.height + 10) })}
              className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/80 hover:bg-white/15 active:scale-95"
            >
              +
            </button>
          </div>
        </div>

        {/* Quick Scale Presets */}
        <div className="flex items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => scaleBy(0.9)}
            className="flex-1 rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/80 hover:bg-white/10 hover:text-white"
          >
            -10% Scale
          </button>
          <button
            type="button"
            onClick={() => scaleBy(1.1)}
            className="flex-1 rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/80 hover:bg-white/10 hover:text-white"
          >
            +10% Scale
          </button>
          <button
            type="button"
            onClick={() => onUpdate({ width: 380, height: 220 })}
            className="flex items-center justify-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold text-white/60 hover:bg-white/10 hover:text-white"
            title="Reset to default 380x220"
          >
            <RotateCcw size={10} />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* ── 3. Quick Screen Alignment Snapping ── */}
      <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
          Snap to Screen Edge
        </span>
        <div className="grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={() => snapTo('tl')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Top Left
          </button>
          <button
            type="button"
            onClick={() => snapTo('tc')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Top Center
          </button>
          <button
            type="button"
            onClick={() => snapTo('tr')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Top Right
          </button>
          <button
            type="button"
            onClick={() => snapTo('cl')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Mid Left
          </button>
          <button
            type="button"
            onClick={() => snapTo('cc')}
            className="rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 py-1 text-[10px] font-bold text-[var(--accent)] hover:bg-[var(--accent)]/20"
          >
            Center
          </button>
          <button
            type="button"
            onClick={() => snapTo('cr')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Mid Right
          </button>
          <button
            type="button"
            onClick={() => snapTo('bl')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Bottom Left
          </button>
          <button
            type="button"
            onClick={() => snapTo('bc')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Bottom Center
          </button>
          <button
            type="button"
            onClick={() => snapTo('br')}
            className="rounded border border-white/10 bg-white/5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15 hover:text-white"
          >
            Bottom Right
          </button>
        </div>
      </div>

      <div className="text-center text-[11px] text-[var(--text-tertiary)] flex items-center justify-center gap-1.5 pt-0.5">
        <Move size={11} className="text-[var(--accent)]" />
        <span>You can also click & drag the widget directly</span>
      </div>
    </div>
  )
}

export function SettingsPopover({ widget }: { widget: Widget }) {
  const [activeTab, setActiveTab] = useState<'settings' | 'hud'>('settings')
  const updateWidget = useCanvasStore((s) => s.updateWidget)
  const def = widgetRegistry[widget.type]
  if (!def || !def.Settings) return null
  if (def.hasSettings && !def.hasSettings(widget)) return null
  const Settings = def.Settings

  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 1080

  const widgetBottom = widget.y + widget.height
  const widgetRight = widget.x + widget.width

  const spaceBelow = viewportH - widgetBottom
  const spaceAbove = widget.y
  const spaceRight = viewportW - widgetRight
  const spaceLeft = widget.x

  // Smart adaptive placement: side vs top vs bottom
  let placement: 'below' | 'above' | 'right' | 'left' = 'below'
  let maxH = 460

  // If widget is tall (like Hero Big Art or resized tall), prefer opening to the side!
  if (widget.height >= 260 && (spaceRight >= 295 || spaceLeft >= 295)) {
    if (spaceRight >= 295) {
      placement = 'right'
      maxH = Math.min(500, viewportH - widget.y - 30)
    } else {
      placement = 'left'
      maxH = Math.min(500, viewportH - widget.y - 30)
    }
  } else if (spaceBelow >= 360) {
    placement = 'below'
    maxH = Math.min(480, spaceBelow - 20)
  } else if (spaceAbove >= 360) {
    placement = 'above'
    maxH = Math.min(480, spaceAbove - 20)
  } else if (spaceRight >= 295) {
    placement = 'right'
    maxH = Math.min(500, viewportH - widget.y - 30)
  } else if (spaceLeft >= 295) {
    placement = 'left'
    maxH = Math.min(500, viewportH - widget.y - 30)
  } else {
    if (spaceBelow >= spaceAbove) {
      placement = 'below'
      maxH = Math.max(200, spaceBelow - 20)
    } else {
      placement = 'above'
      maxH = Math.max(200, spaceAbove - 20)
    }
  }

  const alignRight = widget.x + 300 > viewportW

  let positionClass = 'top-full mt-2.5 left-0'
  if (placement === 'below') {
    positionClass = `top-full mt-2.5 ${alignRight ? 'right-0' : 'left-0'}`
  } else if (placement === 'above') {
    positionClass = `bottom-full mb-2.5 ${alignRight ? 'right-0' : 'left-0'}`
  } else if (placement === 'right') {
    positionClass = 'left-full ml-2.5 top-0'
  } else if (placement === 'left') {
    positionClass = 'right-full mr-2.5 top-0'
  }

  return (
    <motion.div
      data-hit
      data-popover
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15, ease: 'easeOut', delay: 0.18 }}
      style={{ maxHeight: `${maxH}px` }}
      className={cn(
        'absolute z-[50] w-auto max-w-[92vw] overflow-y-auto overflow-x-hidden rounded-[14px] border border-white/15 bg-[#141417] p-3 text-white shadow-2xl overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.25)_transparent]',
        positionClass,
      )}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* Top Tab Bar: Settings vs HUD Layout */}
      <div className="flex items-center gap-1 p-0.5 mb-2.5 bg-white/[0.05] rounded-lg border border-white/10">
        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={cn(
            'flex-1 py-1 px-2 text-xs font-semibold rounded-md transition-all text-center flex items-center justify-center gap-1.5',
            activeTab === 'settings'
              ? 'bg-white/15 text-white shadow-sm'
              : 'text-white/60 hover:text-white hover:bg-white/5'
          )}
        >
          <Settings2 size={13} />
          <span>Settings</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('hud')}
          className={cn(
            'flex-1 py-1 px-2 text-xs font-semibold rounded-md transition-all text-center flex items-center justify-center gap-1.5',
            activeTab === 'hud'
              ? 'bg-[var(--accent)] text-[var(--on-accent)] shadow-sm'
              : 'text-white/60 hover:text-white hover:bg-white/5'
          )}
        >
          <Move size={13} />
          <span>HUD Layout</span>
        </button>
      </div>

      {activeTab === 'settings' ? (
        <Settings
          widget={widget}
          onUpdate={(patch) => updateWidget(widget.id, patch)}
        />
      ) : widget.type === 'nowplaying' ? (
        <ElementHudController
          widget={widget as any}
          onUpdate={(patch) => updateWidget(widget.id, patch as any)}
        />
      ) : (
        <HudLayoutBox
          widget={widget}
          onUpdate={(patch) => updateWidget(widget.id, patch)}
          minSize={def.minSize}
          maxSize={def.maxSize}
        />
      )}
    </motion.div>
  )
}
