// Minimal i18n. A small string table covering the chrome labels in the six
// languages the desktop app ships, plus an RTL flag for Hebrew. Strings not in
// the table fall back to English then the key itself.
import type { Language } from '../model/types';

type Entry = Partial<Record<Language, string>> & { en: string };

const STRINGS: Record<string, Entry> = {
  layers:   { en: 'Layers', he: 'שכבות', fr: 'Calques', es: 'Capas', it: 'Livelli', pt: 'Camadas' },
  settings: { en: 'Settings', he: 'הגדרות', fr: 'Paramètres', es: 'Ajustes', it: 'Impostazioni', pt: 'Definições' },
  save:     { en: 'Save', he: 'שמירה', fr: 'Enregistrer', es: 'Guardar', it: 'Salva', pt: 'Guardar' },
  load:     { en: 'Load…', he: 'טעינה…', fr: 'Charger…', es: 'Cargar…', it: 'Carica…', pt: 'Carregar…' },
  theme:    { en: 'Theme', he: 'ערכת נושא', fr: 'Thème', es: 'Tema', it: 'Tema', pt: 'Tema' },
  language: { en: 'Language', he: 'שפה', fr: 'Langue', es: 'Idioma', it: 'Lingua', pt: 'Idioma' },
  showGrid: { en: 'Show grid', he: 'הצג רשת', fr: 'Afficher la grille', es: 'Mostrar cuadrícula', it: 'Mostra griglia', pt: 'Mostrar grelha' },
  gridSize: { en: 'Grid size', he: 'גודל רשת', fr: 'Taille de grille', es: 'Tamaño de cuadrícula', it: 'Dimensione griglia', pt: 'Tamanho da grelha' },
  snap:     { en: 'Snap to grid', he: 'הצמדה לרשת', fr: 'Aligner sur la grille', es: 'Ajustar a cuadrícula', it: 'Aggancia alla griglia', pt: 'Ajustar à grelha' },
  curve:    { en: 'Curve params', he: 'פרמטרי עקומה', fr: 'Paramètres de courbe', es: 'Parámetros de curva', it: 'Parametri curva', pt: 'Parâmetros de curva' },
  close:    { en: 'Close', he: 'סגירה', fr: 'Fermer', es: 'Cerrar', it: 'Chiudi', pt: 'Fechar' },
};

export function t(key: string, lang: Language): string {
  const e = STRINGS[key];
  return (e && (e[lang] ?? e.en)) ?? key;
}

export const isRTL = (lang: Language): boolean => lang === 'he';
