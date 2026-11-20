// A stand-in browser screenshot for the seed: a page with a header bar and a card, as a PNG the seed uploads. The bar
// is red on a failed step's picture, so the two read apart.
import { deflateSync } from 'node:zlib'

const WIDTH = 640
const HEIGHT = 400

type Rgb = readonly [number, number, number]

const pixel = (x: number, y: number, accent: Rgb): Rgb => {
	if (y < 48) return accent
	if (x > 120 && x < 520 && y > 100 && y < 320) {
		if (y > 140 && y < 156 && x > 150 && x < 400) return [200, 204, 212]
		if (y > 180 && y < 210 && x > 150 && x < 490) return [232, 234, 238]
		if (y > 240 && y < 272 && x > 150 && x < 260) return accent
		return [255, 255, 255]
	}
	return [243, 244, 246]
}

const crc = (bytes: Uint8Array): number => {
	let value = 0xffffffff
	for (const byte of bytes) {
		value ^= byte
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
	}
	return (value ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Uint8Array): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(12 + data.length)
	const view = new DataView(out.buffer)
	view.setUint32(0, data.length)
	out.set(new TextEncoder().encode(type), 4)
	out.set(data, 8)
	view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
	return out
}

export function screenshotPng(accent: Rgb): Blob {
	const raw = new Uint8Array(HEIGHT * (1 + WIDTH * 3))
	for (let y = 0; y < HEIGHT; y++) {
		const row = y * (1 + WIDTH * 3)
		for (let x = 0; x < WIDTH; x++) raw.set(pixel(x, y, accent), row + 1 + x * 3)
	}
	const header = new Uint8Array(13)
	const view = new DataView(header.buffer)
	view.setUint32(0, WIDTH)
	view.setUint32(4, HEIGHT)
	header.set([8, 2, 0, 0, 0], 8)
	const parts = [
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', new Uint8Array(deflateSync(raw))),
		chunk('IEND', new Uint8Array(0)),
	]
	return new Blob(parts, { type: 'image/png' })
}
