import { useState } from 'react';
import { Modal } from './Modal';
import { useEditorStore } from '../store/editorStore';
import { t } from './i18n';
import './settingsDialog.css';

import { GeneralPage } from './settings/GeneralPage';
import { LayerPanelPage } from './settings/LayerPanelPage';
import { SelectedStrandPage } from './settings/SelectedStrandPage';
import { LanguagePage } from './settings/LanguagePage';
import { SaveLoadPage } from './settings/SaveLoadPage';
import { TutorialPage } from './settings/TutorialPage';
import { ButtonGuidePage } from './settings/ButtonGuidePage';
import { HistoryPage } from './settings/HistoryPage';
import { WhatsNewPage } from './settings/WhatsNewPage';
import { SamplesPage } from './settings/SamplesPage';
import { AboutPage } from './settings/AboutPage';
import type { PageProps } from './settings/types';

// Faithful port of settings_dialog.py: a two-pane modal (category sidebar +
// stacked pages). Row index === page index (OSS categories_list ↔ stacked_widget).
// The 11 categories, in OSS order, each with its nav translation key.
const CATEGORIES: ReadonlyArray<{ key: string; Page: (p: PageProps) => JSX.Element }> = [
  { key: 'general_settings', Page: GeneralPage },
  { key: 'layer_panel_title', Page: LayerPanelPage },
  { key: 'selected_strand_settings', Page: SelectedStrandPage },
  { key: 'change_language', Page: LanguagePage },
  { key: 'save_load_settings_title', Page: SaveLoadPage },
  { key: 'tutorial', Page: TutorialPage },
  { key: 'button_explanations', Page: ButtonGuidePage },
  { key: 'history', Page: HistoryPage },
  { key: 'whats_new', Page: WhatsNewPage },
  { key: 'samples', Page: SamplesPage },
  { key: 'about', Page: AboutPage },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const lang = useEditorStore((s) => s.settings.language);
  const [active, setActive] = useState(0);
  const Active = CATEGORIES[active].Page;

  return (
    <Modal
      title={t('settings', lang)}
      onClose={onClose}
      lang={lang}
      onEnter={onClose}
      footer={<button className="set-btn" onClick={onClose}>{t('ok', lang)}</button>}
    >
      <div className="set-dialog">
        <ul className="set-nav">
          {CATEGORIES.map((c, i) => (
            <li
              key={c.key}
              className={'set-nav-item' + (i === active ? ' active' : '')}
              onClick={() => setActive(i)}
            >
              {t(c.key, lang)}
            </li>
          ))}
        </ul>
        <div className="set-content">
          <Active lang={lang} onClose={onClose} />
        </div>
      </div>
    </Modal>
  );
}
