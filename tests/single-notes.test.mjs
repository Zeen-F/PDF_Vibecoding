import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';
import { mergeNotes, MAX_NOTE_LENGTH } from '../shared/notes.mjs';

test('merging notes preserves exact Unicode, Markdown and whitespace, including a whitespace-only source', () => {
  const zh = ' \t## 电路笔记\r\n\n**相位裕度** 与 Ω、µA。🧪\n\n';
  const en = '\n## Evidence\n\n- Preserve `gm/ID`\n- [Source](https://example.com/)  \n';
  assert.equal(mergeNotes(zh, en), `${zh}\n\n---\n\n${en}`);
  assert.equal(mergeNotes('', en), en);
  assert.equal(mergeNotes(zh, ''), zh);
  assert.equal(mergeNotes('', ''), '');
  assert.equal(mergeNotes(' \t', '\n'), ' \t\n\n---\n\n\n');
  assert.equal(mergeNotes('same', 'same'), 'same\n\n---\n\nsame', 'Two independently written fields must not be silently deduplicated');
  assert.equal(MAX_NOTE_LENGTH, 500007, 'One note must hold both old 250,000-character fields plus their separator');
});

function noteSection(markdown) {
  assert.equal((markdown.match(/^## 笔记$/gm) || []).length, 1);
  assert.ok(!/^## (?:中文笔记|English notes)$/m.test(markdown));
  const match = markdown.match(/\n## 笔记\n\n([\s\S]*?)\n\n## 阅读批注\n/);
  assert.ok(match, 'Markdown must contain one complete notes section before the annotations');
  return match[1];
}

test('single-note saves and exports preserve legacy content without rewriting or duplicating source fields', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-single-notes-'));
  let runtime, server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    runtime?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  runtime = createApp({ dataDir });
  server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const bytes = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'notes-example.pdf');
  const upload = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
  assert.equal(upload.status, 201);
  const { document } = await upload.json();
  const documentUrl = `${base}/api/documents/${document.id}`;
  const patch = body => fetch(documentUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const readDocument = async () => (await (await fetch(documentUrl)).json()).document;
  const exportNotes = async () => {
    const response = await fetch(`${documentUrl}/export`);
    assert.equal(response.status, 200);
    return noteSection(await response.text());
  };
  function storedNotes() {
    const db = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'), { readOnly: true });
    try {
      return {
        version: db.prepare('PRAGMA user_version').get().user_version,
        row: { ...db.prepare('SELECT notes_zh,notes_en,updated_at FROM documents WHERE id = ?').get(document.id) },
      };
    } finally { db.close(); }
  }

  await t.test('legacy two-field notes export together with exact characters while raw fields remain unchanged', async () => {
    const zh = ' \t## 研究问题\r\n\n- **中文理解**：电流 µA，温度 27 °C。🧪\n\n';
    const en = '\n## Evidence\n\n```text\ngm/ID = 12\n```\n\n[Original source](https://example.com/)  \n';
    assert.equal((await patch({ notesZh: zh, notesEn: en })).status, 200);
    const before = storedNotes();
    assert.equal(before.version, CURRENT_SCHEMA);
    const expected = `${zh}\n\n---\n\n${en}`;
    assert.equal(await exportNotes(), expected);
    const loaded = await readDocument();
    assert.equal(loaded.notesZh, zh);
    assert.equal(loaded.notesEn, en);
    assert.equal(await exportNotes(), expected);
    assert.deepEqual(storedNotes(), before, 'Read and export must not migrate or rewrite legacy fields');
  });

  await t.test('consolidation retains the full old two-field capacity and rejects over-limit writes atomically', async () => {
    const zh = '界'.repeat(250000);
    const en = 'E'.repeat(250000);
    assert.equal((await patch({ notesZh: zh, notesEn: en })).status, 200);
    const combined = `${zh}\n\n---\n\n${en}`;
    assert.equal(combined.length, MAX_NOTE_LENGTH);
    const saved = await patch({ notesZh: combined, notesEn: '' });
    assert.equal(saved.status, 200);
    const accepted = (await saved.json()).document;
    assert.equal(accepted.notesZh, combined);
    assert.equal(accepted.notesEn, '');
    assert.equal(await exportNotes(), combined);
    const before = storedNotes();
    for (const body of [
      { notesZh: `${combined}x`, notesEn: '' },
      // Each field is individually legal; their merged length is too large.
      { notesZh: combined, notesEn: 'x' },
      { notesZh: '', notesEn: 'E'.repeat(250001) },
    ]) {
      const rejected = await patch(body);
      assert.equal(rejected.status, 400);
      assert.equal(typeof (await rejected.json()).error, 'string');
      assert.deepEqual(storedNotes(), before, 'Rejected writes must retain both content and update time');
    }
    assert.equal((await readDocument()).notesZh, combined);
  });

  await t.test('saving one note, reloading and exporting twice never reappend the old second field', async () => {
    const single = '## 我的笔记\n\nMixed English 和中文。\n\n---\n\n- Evidence remains exactly once.\n';
    assert.equal((await patch({ notesZh: single, notesEn: '' })).status, 200);
    const before = storedNotes();
    for (let visit = 0; visit < 2; visit++) {
      const loaded = await readDocument();
      assert.equal(mergeNotes(loaded.notesZh, loaded.notesEn), single);
      assert.equal(await exportNotes(), single);
    }
    assert.deepEqual(storedNotes(), before);
    assert.equal((await patch({ notesZh: '', notesEn: '' })).status, 200);
    const cleared = await readDocument();
    assert.equal(cleared.notesZh, '');
    assert.equal(cleared.notesEn, '');
    assert.equal(await exportNotes(), '（暂无笔记）');
    assert.equal(await exportNotes(), '（暂无笔记）');
    assert.equal(storedNotes().version, CURRENT_SCHEMA);
  });
});
