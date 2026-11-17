import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as editorPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import type { OverrideDiagnostic } from '../core/override-syntax';
import '../styles/code-editor.css';

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: 'var(--code-keyword)' },
  { tag: [tags.propertyName, tags.definition(tags.variableName)], color: 'var(--accent-text)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning)' },
  { tag: [tags.comment, tags.meta], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.operator], color: 'var(--text-secondary)' },
]);

export default function CodeEditor(props: {
  value: string;
  mode: 'yaml' | 'js';
  disabled: boolean;
  placeholder: string;
  diagnostics: OverrideDiagnostic[];
  checking: boolean;
  onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const compartments = useRef({ language: new Compartment(), writable: new Compartment(), placeholder: new Compartment() });

  useEffect(() => {
    const current = latest.current;
    const { language, writable, placeholder } = compartments.current;
    const view = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: current.value,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(),
        indentOnInput(), bracketMatching(), lintGutter(), syntaxHighlighting(highlight),
        EditorState.tabSize.of(2), indentUnit.of('  '),
        keymap.of([{ key: 'Escape', run: view => { view.setTabFocusMode(2000); return false; } }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        language.of(current.mode === 'yaml' ? yaml() : javascript()),
        writable.of([EditorState.readOnly.of(current.disabled), EditorView.editable.of(!current.disabled)]),
        placeholder.of(editorPlaceholder(current.placeholder)),
        EditorView.contentAttributes.of({ 'aria-label': '覆写内容', spellcheck: 'false', 'aria-multiline': 'true' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && update.state.doc.toString() !== latest.current.value) latest.current.onChange(update.state.doc.toString());
        }),
      ],
    }) });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.value) view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: props.value }, annotations: Transaction.addToHistory.of(false),
    });
  }, [props.value]);
  useEffect(() => {
    editor.current?.dispatch({ effects: compartments.current.language.reconfigure(props.mode === 'yaml' ? yaml() : javascript()) });
  }, [props.mode]);
  useEffect(() => {
    editor.current?.dispatch({ effects: compartments.current.writable.reconfigure([
      EditorState.readOnly.of(props.disabled), EditorView.editable.of(!props.disabled),
    ]) });
  }, [props.disabled]);
  useEffect(() => {
    editor.current?.dispatch({ effects: compartments.current.placeholder.reconfigure(editorPlaceholder(props.placeholder)) });
  }, [props.placeholder]);
  useEffect(() => {
    const view = editor.current;
    if (view) view.dispatch(setDiagnostics(view.state, props.diagnostics.map(issue => ({ ...issue, severity: 'error' as const }))));
  }, [props.diagnostics]);

  const issue = props.diagnostics[0];
  return <div className="code-editor">
    <div className="code-editor-surface" ref={host} />
    <div className={`code-editor-status${issue ? ' has-error' : ''}`} role="status" aria-live="polite">
      {props.checking ? '正在检查语法…' : issue ? <button type="button" className="code-editor-diagnostic"
        onClick={() => { const view = editor.current; if (view) { view.dispatch({ selection: { anchor: issue.from, head: issue.to }, scrollIntoView: true }); view.focus(); } }}>
        第 {issue.line} 行，第 {issue.column} 列 · {issue.message}
      </button> : `${props.mode === 'yaml' ? 'YAML' : 'JavaScript'} · ${props.value.trim() ? '语法检查通过' : '尚未输入内容'}`}
    </div>
  </div>;
}
