// Minimal Web Speech recognition types: TypeScript's DOM lib does not ship them.
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}
type AvailabilityStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';
interface SpeechRecognitionOptions {
  langs: string[];
  processLocally?: boolean;
}
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onaudiostart: (() => void) | null;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
  available?: (options: SpeechRecognitionOptions) => Promise<AvailabilityStatus>;
  install?: (options: SpeechRecognitionOptions) => Promise<boolean>;
}
interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
