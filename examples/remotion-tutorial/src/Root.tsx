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
	/** Base filename (no extension) of the recording + manifest under `public/`. */
	base: string
	/** Filled in by calculateMetadata. */
	manifest?: VideoManifest
	introSeconds?: number
	outroSeconds?: number
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
			defaultProps={{ base: 'create-a-site' } satisfies TutorialProps}
			calculateMetadata={async ({ props }) => {
				const manifest: VideoManifest = await (await fetch(staticFile(`${props.base}.json`))).json()
				const meta = await getVideoMetadata(staticFile(`${props.base}.webm`))
				const width = manifest.size?.width ?? meta.width
				const height = manifest.size?.height ?? meta.height
				const durationInFrames = Math.ceil((INTRO_SECONDS + meta.durationInSeconds + OUTRO_SECONDS) * FPS)
				return {
					durationInFrames,
					fps: FPS,
					width,
					height,
					props: { ...props, manifest, introSeconds: INTRO_SECONDS, outroSeconds: OUTRO_SECONDS },
				}
			}}
		/>
	)
}
