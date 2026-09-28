# Notices

Cascade is MIT-licensed (see `LICENSE`). A few files include code adapted from
other MIT-licensed projects. Their copyright and permission notices are below,
as the MIT license asks.

## Ruflo (formerly claude-flow)

<https://github.com/ruvnet/ruflo>

The hook runtime's layout follows Ruflo's `.claude/helpers/`: a
hook-handler dispatcher plus intelligence, router and session helpers that
keep their state in JSON files. The closest copies:

- `scripts/hooks/hook-handler.cjs`: the stdin reader and the command-dispatch
  skeleton are adapted from Ruflo's `.claude/helpers/hook-handler.cjs`.
- `scripts/hooks/session.cjs`: the session start / restore / end structure
  follows Ruflo's `.claude/helpers/session.cjs`.

```
MIT License

Copyright (c) 2024-2026 ruvnet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Nelson

<https://github.com/Aspegio/nelson>

- `scripts/context-health.py`: the session-log parsing and token-count
  extraction are adapted from Nelson's `scripts/count-tokens.py`.

```
MIT License

Copyright (c) 2025 Harry Munro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ideas borrowed, no code

- [ECC](https://github.com/affaan-m/ECC) by Affaan Mustafa (MIT):
  `scripts/hooks/read-gate.cjs` is modeled on ECC's GateGuard and
  config-protection hooks, and `scripts/hooks/instincts.cjs` on its
  continuous-learning instincts. Both were written from scratch.

## Where Cascade started

Cascade started as a fork of Aman Khan's
[personal-os](https://github.com/amanaiproduct/personal-os) template. None of
the template's files are in the current version. Earlier commits in this
repo's history do include files from it (the task and backlog MCP tools, the
scaffolding templates, the workflow docs). Those files stay under Aman's
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) license,
not MIT.
