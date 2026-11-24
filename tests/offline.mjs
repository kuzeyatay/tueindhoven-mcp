// Inherited by the catalog worker. Every test is offline, including multipart storage.
import assert from 'node:assert/strict';
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://storage.fixture.invalid/one-upload');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers, undefined);
  assert.equal(init.body.get('policy'), 'fixture-policy');
  const file = init.body.get('file');
  assert.equal(file.name, 'answer.txt');
  assert.equal(await file.text(), 'Practice answer');
  return Response.json({ id: '81', display_name: file.name });
};
