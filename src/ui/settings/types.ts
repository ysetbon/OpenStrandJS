import type { Language } from '../../model/types';

// Every settings page receives the active language and a callback to close the
// whole dialog (used by Samples/History, which load a project and dismiss).
export interface PageProps {
  lang: Language;
  onClose: () => void;
}
