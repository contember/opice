/**
 * Project a scenario's stored video R2 key onto a public `videoUrl`, given the
 * surface's URL prefix. Shared by all three read planes — operator (`/videos`),
 * share (`/s/videos`), machine (`/api/v1/<slug>/videos`) — which differ only in
 * that prefix, so the null-guard and the shape live in exactly one place. The
 * raw `videoKey` is left on the object; the RPC output schema strips it.
 */
export function withVideoUrl<T extends { videoKey: string | null }>(
	scenarios: readonly T[],
	prefix: string,
): (T & { videoUrl: string | null })[] {
	return scenarios.map(s => ({ ...s, videoUrl: s.videoKey ? `${prefix}/${s.videoKey}` : null }))
}
