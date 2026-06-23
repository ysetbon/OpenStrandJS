import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { useEditorStore } from '../../store/editorStore';
import { createMask } from '../../store/actions';
import { resolveGroupMembers } from '../../model/group';
import { t, tf } from '../i18n';

// OSS "Create Mask Grid" (mask_grid_dialog.py): an N×N directional crossing
// matrix. Rows and columns are the group's strands; ticking cell (row, col)
// schedules a mask "row_col" — row is the OVER strand, col is the UNDER strand
// it subtracts. The diagonal is greyed (can't mask a strand with itself), and a
// pair that already has a mask shows as checked + disabled. Row/column header
// checkboxes select-all along that row/column. The dialog is NON-MODAL with
// Apply (creates the checked masks and stays open, refreshing) + Close.
export function MaskGridDialog(props: { groupName: string; onClose: () => void }): JSX.Element {
  const { groupName, onClose } = props;
  const lang = useEditorStore((s) => s.settings.language);
  const doc = useEditorStore((s) => s.doc);
  const commitEdit = useEditorStore((s) => s.commitEdit);

  // Group's regular (non-masked) members in z-order — these index the matrix.
  const strands = useMemo(() => {
    const regular = new Set(resolveGroupMembers(doc, groupName).regular);
    return doc.order.filter((n) => regular.has(n) && doc.strands[n]?.type !== 'MaskedStrand');
  }, [doc, groupName]);

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const cellKey = (r: number, c: number) => `${r}_${c}`;

  // A directional mask "over_under" already on the canvas.
  const exists = (over: string, under: string) =>
    doc.strands[`${over}_${under}`]?.type === 'MaskedStrand';

  const cssColor = (n: string): string => {
    const col = doc.strands[n]?.color;
    return col ? `rgb(${col.r}, ${col.g}, ${col.b})` : 'transparent';
  };

  const enabledCols = (r: number) =>
    strands.map((_, c) => c).filter((c) => c !== r && !exists(strands[r], strands[c]));
  const enabledRows = (c: number) =>
    strands.map((_, r) => r).filter((r) => r !== c && !exists(strands[r], strands[c]));

  const rowAll = (r: number) => {
    const cells = enabledCols(r);
    return cells.length > 0 && cells.every((c) => checked[cellKey(r, c)]);
  };
  const colAll = (c: number) => {
    const cells = enabledRows(c);
    return cells.length > 0 && cells.every((r) => checked[cellKey(r, c)]);
  };
  const toggleRow = (r: number) => {
    const v = !rowAll(r);
    setChecked((p) => { const n = { ...p }; for (const c of enabledCols(r)) n[cellKey(r, c)] = v; return n; });
  };
  const toggleCol = (c: number) => {
    const v = !colAll(c);
    setChecked((p) => { const n = { ...p }; for (const r of enabledRows(c)) n[cellKey(r, c)] = v; return n; });
  };
  const toggleCell = (r: number, c: number) =>
    setChecked((p) => ({ ...p, [cellKey(r, c)]: !p[cellKey(r, c)] }));

  const hasPicks = strands.some((_, r) =>
    strands.some((__, c) => r !== c && !exists(strands[r], strands[c]) && checked[cellKey(r, c)]));

  const apply = () => {
    const pairs: Array<[string, string]> = [];
    strands.forEach((rs, r) =>
      strands.forEach((cs, c) => {
        if (r !== c && !exists(rs, cs) && checked[cellKey(r, c)]) pairs.push([rs, cs]);
      }),
    );
    if (!pairs.length) return;
    commitEdit((d) => { for (const [over, under] of pairs) createMask(d, over, under); });
    setChecked({}); // applied masks now render as checked + disabled
  };

  return (
    <Modal
      title={`${t('create_mask_grid', lang)} - ${groupName}`}
      onClose={onClose}
      lang={lang}
      modeless
      footer={
        <>
          <button onClick={apply} disabled={!hasPicks}>{t('apply', lang)}</button>
          <button onClick={onClose}>{t('close', lang)}</button>
        </>
      }
    >
      <div className="gd-maskgrid">
        <div className="gd-field-label">{tf('mask_grid_info', lang, groupName, strands.length)}</div>
        <div className="gd-maskgrid-scroll">
          <table className="gd-maskgrid-table">
            <thead>
              <tr>
                <th className="gd-maskgrid-corner" />
                {strands.map((cs, c) => (
                  <th key={cs} className="gd-maskgrid-colhead">
                    <span className="gd-swatch" style={{ background: cssColor(cs) }} />
                    <span className="gd-maskgrid-name">{cs}</span>
                    <input
                      type="checkbox"
                      checked={colAll(c)}
                      disabled={enabledRows(c).length === 0}
                      onChange={() => toggleCol(c)}
                      title={t('select_all', lang)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {strands.map((rs, r) => (
                <tr key={rs}>
                  <th className="gd-maskgrid-rowhead">
                    <span className="gd-swatch" style={{ background: cssColor(rs) }} />
                    <span className="gd-maskgrid-name">{rs}</span>
                    <input
                      type="checkbox"
                      checked={rowAll(r)}
                      disabled={enabledCols(r).length === 0}
                      onChange={() => toggleRow(r)}
                      title={t('select_all', lang)}
                    />
                  </th>
                  {strands.map((cs, c) => {
                    if (r === c) return <td key={cs} className="gd-maskgrid-diag" />;
                    const ex = exists(rs, cs);
                    return (
                      <td key={cs} className="gd-maskgrid-cell">
                        <input
                          type="checkbox"
                          checked={ex || !!checked[cellKey(r, c)]}
                          disabled={ex}
                          onChange={() => toggleCell(r, c)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export default MaskGridDialog;
