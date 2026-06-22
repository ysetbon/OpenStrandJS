import { useEditorStore } from '../store/editorStore';

// Multi-tab bar. The active tab's document is the live store doc; switching saves
// the current doc/view into the leaving tab and loads the target's.
export function TabBar() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const switchTab = useEditorStore((s) => s.switchTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const newTab = useEditorStore((s) => s.newTab);

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab${t.id === activeTabId ? ' active' : ''}`}
          onClick={() => switchTab(t.id)}
        >
          <span>{t.name}</span>
          <button className="tab-close" title="Close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
        </div>
      ))}
      <button className="tab-new" title="New tab" onClick={newTab}>＋</button>
    </div>
  );
}
