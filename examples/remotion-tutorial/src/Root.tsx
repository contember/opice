import { getVideoMetadata } from '@remotion/media-utils'
import { Composition, staticFile } from 'remotion'
import { Tutorial } from './Tutorial'

export interface VideoStep {
	name: string
	kind: string
	sequence: number
	tStartMs: number
	durationMs: number
	status: string
	cursor?: { x: number; y: number }
}

export interface VideoManifest {
	scenario: string
	video: string
	size?: { width: number; height: number }
	steps: VideoStep[]
}

export interface TutorialProps {
	/** Base filename (no extension) of the recording + manifest under `public/`.
	 *  Optional only so `<Composition>` accepts the component (it's always supplied
	 *  via defaultProps); falls back to `'create-a-site'`. */
	base?: string
	/** Max camera push-in toward the active step's cursor. 0 = no zoom (default —
	 *  a still, full-frame screencast). Try ~0.08 for a subtle follow. */
	zoom?: number
	/** Optional code snippet shown on a full-screen card right after the intro
	 *  (e.g. a tracking <script> to add to your site). Omit to skip the card. */
	code?: string
	/** Heading above the code card (default "Add this to your site"). */
	codeTitle?: string
	/** Filename shown in the code card's title bar (default "index.html"). */
	codeFile?: string
	/** Optional callout shown below the code card (e.g. "takes effect after deploy"). */
	codeNote?: string
	/** How long the code card holds (seconds, default 5.5). Ignored without `code`. */
	codeSeconds?: number
	/** Where the code/implement cards sit (when NOT using `insertCodeAfterStep`):
	 *  `'before'` the screencast (default) or `'after'` it (a "now use it" payoff). */
	codePlacement?: 'before' | 'after'
	/** Optional "implement it" scene shown after the code card: a fuller source file
	 *  (e.g. a full index.html) with the just-copied snippet highlighted in place, to
	 *  simulate pasting it into a real site. Omit to skip. */
	implementCode?: string
	/** Heading above the implement card (default "Paste it into your site"). */
	implementTitle?: string
	/** Filename shown in the implement card's title bar (default "index.html"). */
	implementFile?: string
	/** Inclusive [start, end] 0-based line range to highlight as the inserted snippet. */
	implementRange?: [number, number]
	/** How long the implement card holds (seconds, default 6.5). Ignored without `implementCode`. */
	implementSeconds?: number
	/** Place the code/implement cards INSIDE the screencast: name (substring) of the
	 *  manifest step after which to cut away to the cards, then resume the recording at
	 *  the next step. The skipped gap between them (e.g. a page reload) is hidden behind
	 *  the cards. Omit to keep the cards before the screencast. */
	insertCodeAfterStep?: string
	/** Filled in by calculateMetadata. */
	manifest?: VideoManifest
	introSeconds?: number
	outroSeconds?: number
	/** Split points (ms into the recording), set by calculateMetadata when `insertCodeAfterStep` matches. */
	splitOutMs?: number
	resumeInMs?: number
	videoTotalSec?: number
}

const FPS = 30
const INTRO_SECONDS = 2.4
const OUTRO_SECONDS = 2.4

export const RemotionRoot: React.FC = () => {
	return (
		<Composition
			id="Tutorial"
			component={Tutorial}
			fps={FPS}
			// Sensible fallbacks; calculateMetadata overrides from the manifest/video.
			durationInFrames={300}
			width={1280}
			height={720}
			defaultProps={{ base: 'create-a-site', zoom: 0 } satisfies TutorialProps}
			calculateMetadata={async ({ props }) => {
				const base = props.base ?? 'create-a-site'
				const manifest: VideoManifest = await (await fetch(staticFile(`${base}.json`))).json()
				const meta = await getVideoMetadata(staticFile(`${base}.webm`))
				const width = manifest.size?.width ?? meta.width
				const height = manifest.size?.height ?? meta.height
				const codeSeconds = props.code ? (props.codeSeconds ?? 5.5) : 0
				const implementSeconds = props.implementCode ? (props.implementSeconds ?? 6.5) : 0

				// Optionally cut the cards INTO the screencast after a named step. The gap
				// between that step's end and the next step's start (a reload, say) is dropped.
				let splitOutMs: number | undefined
				let resumeInMs: number | undefined
				let gapMs = 0
				if (props.insertCodeAfterStep && (props.code || props.implementCode)) {
					const idx = manifest.steps.findIndex(s => s.name.toLowerCase().includes(props.insertCodeAfterStep!.toLowerCase()))
					const step = idx >= 0 ? manifest.steps[idx] : undefined
					if (step) {
						splitOutMs = step.tStartMs + step.durationMs
						resumeInMs = manifest.steps[idx + 1]?.tStartMs ?? splitOutMs
						gapMs = Math.max(0, resumeInMs - splitOutMs)
					}
				}

				const playedVideoSec = meta.durationInSeconds - gapMs / 1000
				const durationInFrames = Math.ceil((INTRO_SECONDS + codeSeconds + implementSeconds + playedVideoSec + OUTRO_SECONDS) * FPS)
				return {
					durationInFrames,
					fps: FPS,
					width,
					height,
					props: {
						...props, base, manifest, introSeconds: INTRO_SECONDS, outroSeconds: OUTRO_SECONDS, codeSeconds, implementSeconds,
						splitOutMs, resumeInMs, videoTotalSec: meta.durationInSeconds,
					},
				}
			}}
		/>
	)
}
