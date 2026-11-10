import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NICK_COLORS, buildLines, channelArg, mergeMessages, nickColor, parseCommand, splitLinks } from '../src/static/chat-render.mjs';

const msg = (id, at, text = `m${id}`) => ({ id, channel: 'general', author: 'alice', text, at });

describe('chat render', () => {
  it('splitLinks: task, epic and pull request references become links', () => {
    assert.deepEqual(splitLinks('T-0007 blocks E-0003, see #253 and #general', { repo: 'org/repo' }), [
      { href: '/graph?focus=T-0007', text: 'T-0007' }, { text: ' blocks ' },
      { href: '/graph?focus=E-0003', text: 'E-0003' }, { text: ', see ' },
      { href: 'https://github.com/org/repo/pull/253', text: '#253' }, { text: ' and #general' },
    ]);
    assert.deepEqual(splitLinks('see #253'), [{ text: 'see #253' }], 'no repo known: PR numbers stay text');
    assert.deepEqual(splitLinks('#1', { repo: 'bad repo/x"' }), [{ text: '#1' }], 'only owner/name repos');
    assert.deepEqual(splitLinks('https://x.io/T-0001#253', { repo: 'org/repo' }), [{ href: 'https://x.io/T-0001#253', text: 'https://x.io/T-0001#253' }], 'refs inside a URL stay part of it');
    assert.deepEqual(splitLinks('XT-0001 a#5', { repo: 'org/repo' }), [{ text: 'XT-0001 a#5' }], 'only whole-word refs');
  });

  it('splitLinks: only http(s) becomes a link, trailing punctuation stays text', () => {
    assert.deepEqual(splitLinks('see https://x.io/a?b=1). ok'), [
      { text: 'see ' }, { href: 'https://x.io/a?b=1', text: 'https://x.io/a?b=1' }, { text: '). ok' },
    ]);
    assert.deepEqual(splitLinks('javascript:alert(1)'), [{ text: 'javascript:alert(1)' }]);
    assert.deepEqual(splitLinks('<img src=x onerror=1>'), [{ text: '<img src=x onerror=1>' }]);
    assert.deepEqual(splitLinks('http://a.b'), [{ href: 'http://a.b', text: 'http://a.b' }]);
    assert.deepEqual(splitLinks('<https://a.b/"x>'), [{ text: '<' }, { href: 'https://a.b/', text: 'https://a.b/' }, { text: '"x>' }]);
  });

  it('buildLines inserts a day line when the date changes', () => {
    const lines = buildLines([msg(1, '2026-11-02T23:59:00Z'), msg(2, '2026-11-03T00:01:00Z')], { timeZone: 'UTC' });
    assert.deepEqual(lines.map((l) => l.type), ['day', 'msg', 'day', 'msg']);
    assert.deepEqual(lines.map((l) => l.id), [1, 1, 2, 2], 'a day line carries the id of the message it precedes');
    assert.equal(lines[1].time, '23:59');
    assert.equal(lines[3].time, '00:01');
    assert.equal(lines[1].author, 'alice');
    assert.deepEqual(lines[1].parts, [{ text: 'm1' }]);
    assert.notEqual(lines[0].label, lines[2].label);
    assert.match(lines[1].title, /2026/);
    assert.deepEqual(buildLines([msg(1, '2026-11-03T10:00:00Z'), msg(2, '2026-11-03T11:00:00Z')], { timeZone: 'UTC' }).map((l) => l.type), ['day', 'msg', 'msg']);
  });

  it('mergeMessages dedupes by id', () => {
    const a = [msg(1, 'x'), msg(2, 'x')];
    assert.deepEqual(mergeMessages(a, [msg(3, 'x'), msg(2, 'x')]).map((m) => m.id), [1, 2, 3]);
    assert.deepEqual(mergeMessages([], [msg(5, 'x'), msg(4, 'x')]).map((m) => m.id), [4, 5]);
  });

  it('nickColor: same nick, same color; spread across the palette', () => {
    assert.equal(nickColor('member-b'), nickColor('member-b'));
    const used = new Set(['member-b', 'ana', 'daniel', 'member-c', 'member-d', 'member-a', 'owner', 'bob'].map(nickColor));
    assert.ok(used.size >= 4, `only ${used.size} colors`);
    for (const c of used) assert.ok(Number.isInteger(c) && c >= 0 && c < NICK_COLORS);
  });

  it('parseCommand: IRC-style slash commands; plain text and // pass through', () => {
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand('  '), null);
    assert.deepEqual(parseCommand('/join #ops'), { cmd: 'join', arg: 'ops' });
    assert.deepEqual(parseCommand('/j ops'), { cmd: 'join', arg: 'ops' });
    assert.deepEqual(parseCommand('/create #dev-2'), { cmd: 'create', arg: 'dev-2' });
    assert.deepEqual(parseCommand('/delete ops'), { cmd: 'delete', arg: 'ops' });
    assert.deepEqual(parseCommand('/HELP'), { cmd: 'help', arg: '' });
    assert.deepEqual(parseCommand('/clear'), { cmd: 'clear', arg: '' });
    assert.deepEqual(parseCommand('/nope x'), { cmd: 'unknown', arg: 'nope' });
    assert.deepEqual(parseCommand('//usr/bin is a path'), { cmd: 'say', arg: '/usr/bin is a path' });
    assert.deepEqual(parseCommand('/constructor'), { cmd: 'unknown', arg: 'constructor' });
    assert.deepEqual(parseCommand('/toString x'), { cmd: 'unknown', arg: 'toString' });
    assert.deepEqual(parseCommand('/JOIN #General'), { cmd: 'join', arg: 'general' });
    assert.deepEqual(parseCommand('/delete ../../x?'), { cmd: 'delete', arg: '../../x?' });
  });

  it('channelArg: only a valid channel name, else null', () => {
    assert.equal(channelArg('ops'), 'ops');
    assert.equal(channelArg('dev-2'), 'dev-2');
    for (const bad of ['', '../../x?', 'a b', 'Ops', '-x', 'x'.repeat(25)]) assert.equal(channelArg(bad), null, bad);
  });
});
