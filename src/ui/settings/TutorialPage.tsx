import { useState } from 'react';
import { Modal } from '../Modal';
import { t } from '../i18n';
import { tutorialVideoUrl, TUTORIAL_COUNT } from './assets';
import type { PageProps } from './types';

// Tutorial page (settings_dialog.py index 5). A centered header + 4 entries, each
// an explanation (gif_explanation_1..4) and a centered Play button (180x40) that
// opens the bundled mp4 in an in-app HTML5 <video> modal (OSS VideoPlayerDialog).
export function TutorialPage({ lang }: PageProps) {
  const [playing, setPlaying] = useState<number | null>(null);

  return (
    <div className="set-page" style={{ width: 'min(560px, 100%)' }}>
      <div className="set-page-header">{t('tutorial_info', lang)}</div>

      {Array.from({ length: TUTORIAL_COUNT }, (_v, i) => i + 1).map((n) => (
        <div key={n} className="set-tutorial-entry">
          <div className="set-tutorial-text">{t(`gif_explanation_${n}`, lang)}</div>
          <div className="set-btn-col">
            <button
              type="button"
              className="set-btn"
              style={{ width: 180, height: 40, padding: 5 }}
              onClick={() => setPlaying(n)}
            >
              {t('play_video', lang)}
            </button>
          </div>
        </div>
      ))}

      {playing != null && (
        <Modal
          title={`${t('tutorial', lang)} ${playing}`}
          onClose={() => setPlaying(null)}
          lang={lang}
          onEnter={() => setPlaying(null)}
          footer={<button className="set-btn" onClick={() => setPlaying(null)}>{t('close', lang)}</button>}
        >
          <div className="set-video-body">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={tutorialVideoUrl(playing)} controls autoPlay />
          </div>
        </Modal>
      )}
    </div>
  );
}
