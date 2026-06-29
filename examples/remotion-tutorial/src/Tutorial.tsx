import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import type { TutorialProps, VideoStep } from './Root'

const BLUE = '#005ae0'
const FONT = 'Inter, "SF Pro Display", system-ui, -apple-system, sans-serif'
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export const Tutorial: React.FC<TutorialProps> = ({ base, manifest, introSeconds = 2.4, outroSeconds = 2.4 }) => {
	const { fps, width, height, durationInFrames } = useVideoConfig()
	if (!manifest) return null
	const introFrames = Math.round(introSeconds * fps)
	const outroFrames = Math.round(outroSeconds * fps)
	const videoFrames = durationInFrames - introFrames - outroFrames

	return (
		<AbsoluteFill style={{ backgroundColor: '#0a0a0a' }}>
			<Sequence durationInFrames={introFrames}>
				<Intro name={manifest.scenario} />
			</Sequence>
			<Sequence from={introFrames} durationInFrames={videoFrames}>
				<VideoStage base={base} steps={manifest.steps} width={width} height={height} />
			</Sequence>
			<Sequence from={introFrames + videoFrames} durationInFrames={outroFrames}>
				<Outro />
			</Sequence>
		</AbsoluteFill>
	)
}

/** Active-step zoom toward the cursor anchor; scale eases in/out at step edges so
 *  back-to-back steps never jump. Returns origin in % of the frame. */
function focusAt(tSec: number, steps: VideoStep[], w: number, h: number): { scale: number; ox: number; oy: number } {
	const ms = tSec * 1000
	const active = steps.find(
		(s) => s.cursor && s.cursor.x >= 0 && s.cursor.y >= 0 && ms >= s.tStartMs && ms <= s.tStartMs + s.durationMs,
	)
	if (!active?.cursor) return { scale: 1, ox: 50, oy: 50 }
	const localMs = ms - active.tStartMs
	const ramp = clamp01(Math.min(localMs / 350, (active.durationMs - localMs) / 350))
	return { scale: 1 + 0.16 * ramp, ox: (active.cursor.x / w) * 100, oy: (active.cursor.y / h) * 100 }
}

const VideoStage: React.FC<{ base: string; steps: VideoStep[]; width: number; height: number }> = ({ base, steps, width, height }) => {
	const frame = useCurrentFrame()
	const { fps } = useVideoConfig()
	const tSec = frame / fps
	const focus = focusAt(tSec, steps, width, height)
	return (
		<AbsoluteFill style={{ backgroundColor: '#fff', overflow: 'hidden' }}>
			<AbsoluteFill style={{ transform: `scale(${focus.scale})`, transformOrigin: `${focus.ox}% ${focus.oy}%` }}>
				<OffthreadVideo src={staticFile(`${base}.webm`)} />
			</AbsoluteFill>
			<Caption steps={steps} tSec={tSec} />
		</AbsoluteFill>
	)
}

const Caption: React.FC<{ steps: VideoStep[]; tSec: number }> = ({ steps, tSec }) => {
	const ms = tSec * 1000
	const idx = steps.findIndex((s) => ms >= s.tStartMs && ms <= s.tStartMs + s.durationMs)
	if (idx < 0) return null
	const s = steps[idx]
	const localMs = ms - s.tStartMs
	const opacity = clamp01(Math.min(localMs / 250, (s.durationMs - localMs) / 250))
	return (
		<AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 48 }}>
			<div
				style={{
					opacity,
					transform: `translateY(${interpolate(opacity, [0, 1], [14, 0])}px)`,
					display: 'flex',
					alignItems: 'center',
					gap: 14,
					maxWidth: '80%',
					padding: '12px 18px 12px 12px',
					borderRadius: 14,
					background: 'rgba(10,10,12,0.82)',
					backdropFilter: 'blur(6px)',
					boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
					fontFamily: FONT,
				}}
			>
				<span
					style={{
						flex: 'none',
						background: BLUE,
						color: '#fff',
						fontSize: 15,
						fontWeight: 700,
						borderRadius: 9,
						padding: '6px 11px',
						letterSpacing: 0.3,
					}}
				>
					Step {idx + 1}/{steps.length}
				</span>
				<span style={{ color: '#fff', fontSize: 26, fontWeight: 600, letterSpacing: -0.2 }}>{s.name}</span>
			</div>
		</AbsoluteFill>
	)
}

const Intro: React.FC<{ name: string }> = ({ name }) => {
	const frame = useCurrentFrame()
	const { fps, durationInFrames } = useVideoConfig()
	const appear = spring({ frame, fps, config: { damping: 200 } })
	const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
	return (
		<AbsoluteFill
			style={{
				background: `radial-gradient(120% 120% at 50% 0%, #1565ff 0%, ${BLUE} 55%, #0042a8 100%)`,
				justifyContent: 'center',
				alignItems: 'center',
				opacity: out,
				fontFamily: FONT,
			}}
		>
			<div style={{ textAlign: 'center', color: '#fff', opacity: appear, transform: `translateY(${interpolate(appear, [0, 1], [22, 0])}px)` }}>
				<div style={{ fontSize: 22, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.85 }}>nua site · tutorial</div>
				<div style={{ fontSize: 66, fontWeight: 800, marginTop: 14, letterSpacing: -1.5 }}>{name}</div>
			</div>
		</AbsoluteFill>
	)
}

const Outro: React.FC = () => {
	const frame = useCurrentFrame()
	const { fps } = useVideoConfig()
	const appear = spring({ frame, fps, config: { damping: 200 } })
	return (
		<AbsoluteFill style={{ backgroundColor: '#0a0a0a', justifyContent: 'center', alignItems: 'center', fontFamily: FONT }}>
			<div style={{ textAlign: 'center', color: '#fff', opacity: appear, transform: `scale(${interpolate(appear, [0, 1], [0.96, 1])})` }}>
				<div style={{ fontSize: 50, fontWeight: 800, letterSpacing: -1 }}>That's it ✨</div>
				<div style={{ fontSize: 24, opacity: 0.7, marginTop: 12 }}>nua site — User guide</div>
			</div>
		</AbsoluteFill>
	)
}
