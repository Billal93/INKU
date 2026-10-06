// Compléments de types pour le contrôle `tsc --checkJs` du Montage (aucun code exécuté).
// API récentes absentes des déclarations standard de TypeScript ou propres à certains navigateurs.
interface Navigator { deviceMemory?: number }
interface FileSystemFileHandle { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
interface Window {
  webkitAudioContext?: typeof AudioContext;
  /** Points d'accroche pour les tests automatiques et l'écran d'autotest. */
  __studio?: any; __studioReady?: boolean; __studioError?: string; __lintCount?: number;
}
interface Performance { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }; measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }
