import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig({
	// phonon-tts resolves its worker and WASM files with `new URL(...,
	// import.meta.url)`; pre-bundling would rewrite those paths wrongly.
	// LiteParse ships a wasm asset referenced the same way.
	optimizeDeps: { exclude: ['phonon-tts', '@llamaindex/liteparse-wasm'] },
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: 'index.html' })
		}),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'OCR-TTS Reader',
				short_name: 'OCR-TTS',
				description: 'OCR PDFs to Markdown and listen with TTS',
				theme_color: '#121212',
				background_color: '#121212',
				display: 'standalone',
				icons: [
					{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
				]
			},
			workbox: {
				// Precache app chunks plus the LiteParse wasm so PDF extraction
				// works offline right after install. Phonon's ~18 MB runtime is
				// deliberately excluded: it caches models after first use.
				globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
				globIgnores: ['**/phonon_tts*'],
				maximumFileSizeToCacheInBytes: 8 * 1024 * 1024
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
