import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import type { TutorialProps, VideoStep } from './Root'

const BLUE = '#005ae0'
const FONT = 'Inter, "SF Pro Display", system-ui, -apple-system, sans-serif'
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export const Tutorial: React.FC<TutorialProps> = (
	{
		base = 'create-a-site', manifest, introSeconds = 2.4, outroSeconds = 2.4, codeSeconds = 0, implementSeconds = 0, zoom = 0,
		code, codeTitle, codeFile, implementCode, implementTitle, implementFile, implementRange, codePlacement = 'before',
		splitOutMs, resumeInMs, videoTotalSec,
	},
) => {
	const { fps, width, height, durationInFrames } = useVideoConfig()
	if (!manifest) return null
	const introFrames = Math.round(introSeconds * fps)
	const outroFrames = Math.round(outroSeconds * fps)
	const codeFrames = code ? Math.round(codeSeconds * fps) : 0
	const implementFrames = implementCode ? Math.round(implementSeconds * fps) : 0
	const videoFrames = durationInFrames - introFrames - codeFrames - implementFrames - outroFrames

	const codeCard = code
		? <CodeCard code={code} title={codeTitle ?? 'Add this to your site'} file={codeFile ?? 'index.html'} />
		: null
	const implementCard = implementCode
		? <ImplementCard code={implementCode} title={implementTitle ?? 'Paste it into your site'} file={implementFile ?? 'index.html'} range={implementRange} />
		: null

	const split = splitOutMs != null && resumeInMs != null && videoTotalSec != null && (code || implementCode)

	if (split) {
		// Cards INSIDE the screencast: intro → recording[0..copy] → cards → recording[dashboard..end] → outro.
		const segAFrames = Math.round((splitOutMs / 1000) * fps)
		const resumeFrames = Math.round((resumeInMs / 1000) * fps)
		const videoTotalFrames = Math.round(videoTotalSec * fps)
		const segBFrames = videoFrames - segAFrames
		const segAAt = introFrames
		const codeAt = segAAt + segAFrames
		const implementAt = codeAt + codeFrames
		const segBAt = implementAt + implementFrames
		const outroAt = segBAt + segBFrames
		return (
			<AbsoluteFill style={{ backgroundColor: '#0a0a0a' }}>
				<Sequence from={0} durationInFrames={introFrames}><Intro name={manifest.scenario} /></Sequence>
				<Sequence from={segAAt} durationInFrames={segAFrames}>
					<VideoStage base={base} steps={manifest.steps} width={width} height={height} videoDurSec={videoFrames / fps} zoom={zoom} trimBeforeF={0} trimAfterF={segAFrames} />
				</Sequence>
				{codeCard && <Sequence from={codeAt} durationInFrames={codeFrames}>{codeCard}</Sequence>}
				{implementCard && <Sequence from={implementAt} durationInFrames={implementFrames}>{implementCard}</Sequence>}
				<Sequence from={segBAt} durationInFrames={segBFrames}>
					<VideoStage base={base} steps={manifest.steps} width={width} height={height} videoDurSec={videoFrames / fps} zoom={zoom} trimBeforeF={resumeFrames} trimAfterF={videoTotalFrames} webmOffsetMs={resumeInMs} />
				</Sequence>
				<Sequence from={outroAt} durationInFrames={outroFrames}><Outro /></Sequence>
			</AbsoluteFill>
		)
	}

	// Default: cards sit before or after the screencast (no split).
	const screencast = (
		<VideoStage base={base} steps={manifest.steps} width={width} height={height} videoDurSec={videoFrames / fps} zoom={zoom} />
	)
	if (codePlacement === 'after') {
		// intro → screencast → (code card) → (implement card) → outro.
		const videoAt = introFrames
		const codeAt = videoAt + videoFrames
		const implementAt = codeAt + codeFrames
		const outroAt = implementAt + implementFrames
		return (
			<AbsoluteFill style={{ backgroundColor: '#0a0a0a' }}>
				<Sequence from={0} durationInFrames={introFrames}><Intro name={manifest.scenario} /></Sequence>
				<Sequence from={videoAt} durationInFrames={videoFrames}>{screencast}</Sequence>
				{codeCard && <Sequence from={codeAt} durationInFrames={codeFrames}>{codeCard}</Sequence>}
				{implementCard && <Sequence from={implementAt} durationInFrames={implementFrames}>{implementCard}</Sequence>}
				<Sequence from={outroAt} durationInFrames={outroFrames}><Outro /></Sequence>
			</AbsoluteFill>
		)
	}
	// intro → (code card) → (implement card) → screencast → outro.
	const codeAt = introFrames
	const implementAt = codeAt + codeFrames
	const videoAt = implementAt + implementFrames
	const outroAt = videoAt + videoFrames
	return (
		<AbsoluteFill style={{ backgroundColor: '#0a0a0a' }}>
			<Sequence from={0} durationInFrames={introFrames}><Intro name={manifest.scenario} /></Sequence>
			{codeCard && <Sequence from={codeAt} durationInFrames={codeFrames}>{codeCard}</Sequence>}
			{implementCard && <Sequence from={implementAt} durationInFrames={implementFrames}>{implementCard}</Sequence>}
			<Sequence from={videoAt} durationInFrames={videoFrames}>{screencast}</Sequence>
			<Sequence from={outroAt} durationInFrames={outroFrames}><Outro /></Sequence>
		</AbsoluteFill>
	)
}

const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, "Menlo", monospace'

/** Minimal HTML highlighter — comments/doctype gray, tags green, strings amber. No deps. */
function highlight(line: string, key: number): React.ReactNode {
	const parts: React.ReactNode[] = []
	const re = /(<!--[\s\S]*?-->|<!doctype[^>]*>)|("[^"]*")|(<\/?[a-zA-Z][^>]*>)/gi
	let last = 0
	let m: RegExpExecArray | null
	let i = 0
	// eslint-disable-next-line no-cond-assign
	while ((m = re.exec(line))) {
		if (m.index > last) parts.push(<span key={`t${key}-${i++}`}>{line.slice(last, m.index)}</span>)
		if (m[1]) parts.push(<span key={`c${key}-${i++}`} style={{ color: '#6e7681' }}>{m[1]}</span>)
		else if (m[2]) parts.push(<span key={`s${key}-${i++}`} style={{ color: '#ffcb6b' }}>{m[2]}</span>)
		else parts.push(<span key={`g${key}-${i++}`} style={{ color: '#7ee787' }}>{m[3]}</span>)
		last = m.index + m[0].length
	}
	if (last < line.length) parts.push(<span key={`r${key}`}>{line.slice(last)}</span>)
	return parts
}

const CodeCard: React.FC<{ code: string; title: string; file: string }> = ({ code, title, file }) => {
	const frame = useCurrentFrame()
	const { fps, durationInFrames } = useVideoConfig()
	const appear = spring({ frame, fps, config: { damping: 200 } })
	const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
	const lines = code.replace(/\n+$/, '').split('\n')
	return (
		<AbsoluteFill
			style={{
				background: 'radial-gradient(130% 130% at 50% 0%, #10233f 0%, #0a0a0a 60%)',
				justifyContent: 'center',
				alignItems: 'center',
				fontFamily: FONT,
				opacity: out,
			}}
		>
			<div style={{ width: '86%', maxWidth: 1160, opacity: appear, transform: `translateY(${interpolate(appear, [0, 1], [26, 0])}px)` }}>
				<div style={{ color: '#fff', fontSize: 40, fontWeight: 800, letterSpacing: -0.8, marginBottom: 22 }}>{title}</div>
				<div style={{ borderRadius: 18, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.55)', border: '1px solid #1f2937' }}>
					<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#161b22', padding: '14px 18px', borderBottom: '1px solid #1f2937' }}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
							<div style={{ display: 'flex', gap: 8 }}>
								<span style={{ width: 13, height: 13, borderRadius: '50%', background: '#ff5f56' }} />
								<span style={{ width: 13, height: 13, borderRadius: '50%', background: '#ffbd2e' }} />
								<span style={{ width: 13, height: 13, borderRadius: '50%', background: '#27c93f' }} />
							</div>
							<span style={{ color: '#8b949e', fontSize: 18, fontFamily: MONO }}>{file}</span>
						</div>
						<span style={{ color: '#c9d1d9', fontSize: 16, fontWeight: 600, background: '#21262d', borderRadius: 8, padding: '6px 14px' }}>Copy</span>
					</div>
					<div style={{ background: '#0d1117', padding: '24px 26px', fontFamily: MONO, fontSize: 22, lineHeight: 1.8, color: '#e6edf3' }}>
						{lines.map((line, idx) => (
							<div key={idx} style={{ whiteSpace: 'pre' }}>{line === '' ? ' ' : highlight(line, idx)}</div>
						))}
					</div>
				</div>
			</div>
		</AbsoluteFill>
	)
}

/** Like CodeCard, but shows a fuller source file with the just-copied snippet
 *  highlighted in place — the surrounding code dims back, the inserted lines glow
 *  in on a short delay, simulating pasting it into a real site. */
const ImplementCard: React.FC<{ code: string; title: string; file: string; range?: [number, number] }> = ({ code, title, file, range }) => {
	const frame = useCurrentFrame()
	const { fps, durationInFrames } = useVideoConfig()
	const appear = spring({ frame, fps, config: { damping: 200 } })
	const reveal = spring({ frame: frame - Math.round(0.55 * fps), fps, config: { damping: 200 } })
	const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
	const lines = code.replace(/\n+$/, '').split('\n')
	const [hs, he] = range ?? [-1, -1]
	return (
		<AbsoluteFill
			style={{
				background: 'radial-gradient(130% 130% at 50% 0%, #10233f 0%, #0a0a0a 60%)',
				justifyContent: 'center',
				alignItems: 'center',
				fontFamily: FONT,
				opacity: out,
			}}
		>
			<div style={{ width: '86%', maxWidth: 1160, opacity: appear, transform: `translateY(${interpolate(appear, [0, 1], [26, 0])}px)` }}>
				<div style={{ color: '#fff', fontSize: 40, fontWeight: 800, letterSpacing: -0.8, marginBottom: 22 }}>{title}</div>
				<div style={{ borderRadius: 18, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.55)', border: '1px solid #1f2937' }}>
					<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#161b22', padding: '14px 18px', borderBottom: '1px solid #1f2937' }}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
							<div style={{ display: 'flex', gap: 8 }}>
								<span style={{ width: 13, height: 13, borderRadius: '50%', background: '#ff5f56' }} />
								<span style={{ width: 13, height: 13, borderRadius: '50%', background: '#ffbd2e' }} />
								<span style={{ width: 13, height: 13, borderRadius: '50%', background: '#27c93f' }} />
							</div>
							<span style={{ color: '#8b949e', fontSize: 18, fontFamily: MONO }}>{file}</span>
						</div>
						<span style={{ color: '#7ee787', fontSize: 16, fontWeight: 600, background: 'rgba(126,231,135,0.12)', borderRadius: 8, padding: '6px 14px' }}>+ pasted</span>
					</div>
					<div style={{ background: '#0d1117', padding: '22px 0', fontFamily: MONO, fontSize: 18, lineHeight: 1.72, color: '#e6edf3' }}>
						{lines.map((line, idx) => {
							const inserted = idx >= hs && idx <= he
							return (
								<div
									key={idx}
									style={{
										whiteSpace: 'pre',
										padding: '0 26px',
										borderLeft: inserted ? '3px solid #7ee787' : '3px solid transparent',
										background: inserted ? 'rgba(126,231,135,0.10)' : 'transparent',
										opacity: inserted ? reveal : 0.4,
										transform: inserted ? `translateY(${interpolate(reveal, [0, 1], [7, 0])}px)` : 'none',
									}}
								>
									{line === '' ? ' ' : highlight(line, idx)}
								</div>
							)
						})}
					</div>
				</div>
			</div>
		</AbsoluteFill>
	)
}

const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp01((x - a) / (b - a))
	return t * t * (3 - 2 * t)
}

const EASE_SECONDS = 0.8

/** A calm "camera": an optional slight, continuously-eased push-in (`zoom`, 0 =
 *  off) whose focus pans smoothly between each step's cursor anchor — no per-step
 *  zoom in/out, no snapping. Origin is returned in % of the frame. */
function camera(tSec: number, steps: VideoStep[], w: number, h: number, videoDurSec: number, zoom: number): { scale: number; ox: number; oy: number } {
	const keys = steps
		.filter((s) => s.cursor && s.cursor.x >= 0 && s.cursor.y >= 0)
		.map((s) => ({ t: (s.tStartMs + s.durationMs / 2) / 1000, x: (s.cursor!.x / w) * 100, y: (s.cursor!.y / h) * 100 }))

	let ox = 50
	let oy = 50
	if (keys.length === 1) {
		ox = keys[0].x
		oy = keys[0].y
	} else if (keys.length > 1) {
		const first = keys[0]
		const last = keys[keys.length - 1]
		if (tSec <= first.t) {
			ox = first.x
			oy = first.y
		} else if (tSec >= last.t) {
			ox = last.x
			oy = last.y
		} else {
			for (let i = 0; i < keys.length - 1; i++) {
				const a = keys[i]
				const b = keys[i + 1]
				if (tSec >= a.t && tSec <= b.t) {
					const e = smoothstep(a.t, b.t, tSec)
					ox = a.x + (b.x - a.x) * e
					oy = a.y + (b.y - a.y) * e
					break
				}
			}
		}
	}
	// Ease the push-in at the very start and end so it breathes, otherwise hold.
	const env = Math.min(smoothstep(0, EASE_SECONDS, tSec), smoothstep(0, EASE_SECONDS, videoDurSec - tSec))
	return { scale: 1 + zoom * env, ox, oy }
}

const VideoStage: React.FC<{
	base: string
	steps: VideoStep[]
	width: number
	height: number
	videoDurSec: number
	zoom: number
	/** Play only a window of the recording (frames). Omit to play the whole file. */
	trimBeforeF?: number
	trimAfterF?: number
	/** ms into the recording this segment starts at — so captions/camera map to the
	 *  original step timeline even when the recording is split into segments. */
	webmOffsetMs?: number
}> = ({ base, steps, width, height, videoDurSec, zoom, trimBeforeF, trimAfterF, webmOffsetMs = 0 }) => {
	const frame = useCurrentFrame()
	const { fps } = useVideoConfig()
	// Time within the original recording (not the composition) — keeps captions and
	// the camera aligned to the manifest's step timestamps across a split.
	const webmSec = webmOffsetMs / 1000 + frame / fps
	const trim = trimBeforeF != null || trimAfterF != null
		? { trimBefore: trimBeforeF ?? 0, ...(trimAfterF != null ? { trimAfter: trimAfterF } : {}) }
		: {}
	const video = <OffthreadVideo src={staticFile(`${base}.webm`)} {...trim} />
	return (
		<AbsoluteFill style={{ backgroundColor: '#fff', overflow: 'hidden' }}>
			{zoom > 0
				? (() => {
					const focus = camera(webmSec, steps, width, height, videoDurSec, zoom)
					return <AbsoluteFill style={{ transform: `scale(${focus.scale})`, transformOrigin: `${focus.ox}% ${focus.oy}%` }}>{video}</AbsoluteFill>
				})()
				: video}
			<Caption steps={steps} tSec={webmSec} />
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
