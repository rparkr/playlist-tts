/** Web Speech API wrapper — sentence-level playback with Web Speech */

export interface WebSpeechState {
	voices: SpeechSynthesisVoice[];
	selectedVoice: SpeechSynthesisVoice | null;
	rate: number;
}

export function getVoices(): SpeechSynthesisVoice[] {
	if (typeof window === 'undefined' || !window.speechSynthesis) return [];
	return window.speechSynthesis.getVoices();
}

export function createUtterance(text: string, voice: SpeechSynthesisVoice | null, rate: number): SpeechSynthesisUtterance {
	const u = new SpeechSynthesisUtterance(text);
	if (voice) u.voice = voice;
	u.rate = rate;
	u.volume = 1;
	return u;
}

export function speakWithCallbacks(
	text: string,
	voice: SpeechSynthesisVoice | null,
	rate: number,
	onEnd: () => void,
	onError: (e: SpeechSynthesisErrorEvent) => void
) {
	if (typeof window === 'undefined') return;
	const synth = window.speechSynthesis;
	synth.cancel(); // flush prior utterance before speaking (prevents overlap)
	const utter = createUtterance(text, voice, rate);
	utter.onend = () => onEnd();
	utter.onerror = (e) => onError(e);
	synth.speak(utter);
}

export function cancelSpeech() {
	if (typeof window !== 'undefined' && window.speechSynthesis) {
		window.speechSynthesis.cancel();
	}
}

export function pauseSpeech() {
	if (typeof window !== 'undefined' && window.speechSynthesis) {
		window.speechSynthesis.pause();
	}
}

export function resumeSpeech() {
	if (typeof window !== 'undefined' && window.speechSynthesis) {
		window.speechSynthesis.resume();
	}
}
