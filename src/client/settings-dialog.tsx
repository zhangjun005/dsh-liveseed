import { useState, type ReactNode } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';

/** Native modal ownership, with the same header / category / content layout as DSH settings. */
export function SettingsDialog({ open, onClose, sections }: {
  open: boolean; onClose(): void;
  sections: readonly { id: string; label: string; content: ReactNode }[];
}) {
  const [selection, setSelection] = useState('memory');
  const active = sections.find(section => section.id === selection) ?? sections[0];
  return <Modal open={open} onClose={onClose} title="德谬歌设置" headless className="ls-settings-modal">
    <style>{styles}</style>
    <header className="ls-settings-header"><h2>德谬歌设置</h2><Button variant="ghost" size="sm" aria-label="关闭德谬歌设置" onClick={onClose}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
    </Button></header>
    <div className="ls-settings-layout">
      <nav className="ls-settings-categories" aria-label="德谬歌设置分类">{sections.map(section => <Button key={section.id} variant="ghost"
        className={active?.id === section.id ? 'ls-settings-category-active' : ''} aria-current={active?.id === section.id ? 'page' : undefined}
        onClick={() => setSelection(section.id)}>{section.label}</Button>)}</nav>
      <section className="ls-settings-content" aria-label={active?.label}>{active?.content}</section>
    </div>
  </Modal>;
}
const styles = `
.ls-settings-modal{width:min(800px,calc(100vw - 32px))!important;max-width:800px!important;height:min(800px,calc(100dvh - 120px));padding:0!important;display:flex;flex-direction:column;gap:0;overflow:hidden;color:var(--dsw-alias-label-primary)}
.ls-settings-header{display:flex;align-items:center;justify-content:space-between;padding:22px 24px 12px;flex:none}.ls-settings-header h2{font-size:16px;font-weight:500;margin:0}
.ls-settings-layout{display:flex;flex:1;min-height:0;padding:0 12px 24px;gap:12px}.ls-settings-categories{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;flex:0 0 176px;padding:0 8px 0 0}.ls-settings-categories button{width:100%;justify-content:flex-start!important}.ls-settings-category-active{background:var(--dsw-alias-bg-module-platform)!important;font-weight:500}
.ls-settings-content{flex:1;min-width:0;overflow:auto;padding:0 12px 24px 24px}.ls-settings-content h3{font-size:14px;font-weight:500;margin:0 0 8px}.ls-settings-description{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);margin:0 0 8px}
.ls-file-path{display:block;box-sizing:border-box;width:100%;font:inherit;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;cursor:text;color:var(--dsw-alias-label-secondary)}
.ls-setting-row{display:flex;align-items:flex-start;gap:24px;padding:20px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}.ls-setting-copy{flex:1;min-width:0}.ls-setting-copy label{display:block;font-size:14px;margin-bottom:6px}.ls-setting-copy p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}.ls-setting-controls{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:0 1 260px;min-width:0}.ls-setting-controls input,.ls-setting-controls select{box-sizing:border-box;width:100%;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:9px 12px}.ls-settings-status{font-size:12px;margin:16px 0;color:var(--dsw-alias-label-secondary)}
@media(max-width:600px){.ls-settings-modal{height:calc(100dvh - 32px)}.ls-settings-header{padding:16px}.ls-settings-layout{flex-direction:column;gap:12px;padding:0 16px 16px}.ls-settings-categories{flex:0 0 auto;flex-direction:row;padding:0;overflow:auto}.ls-settings-categories button{width:auto}.ls-settings-content{padding:0}.ls-setting-row{flex-direction:column;gap:12px}.ls-setting-controls{flex:auto;width:100%}}
`;
