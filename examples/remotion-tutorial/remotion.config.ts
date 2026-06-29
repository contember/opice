import { Config } from '@remotion/cli/config'

Config.setVideoImageFormat('jpeg')
Config.setOverwriteOutput(true)
// The source recordings are .webm (VP8/VP9). OffthreadVideo handles them.
