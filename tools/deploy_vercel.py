#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deploy guardian-ai lên Vercel qua connector CLI (/opt/hatch/bin/vercel call-tool).
- upload_file + create_deployment KHÔNG kèm teamId/scope (gắn scope là 403).
- Chỉ deploy source cần để build Next.js; bỏ node_modules/.next/.git/.env.local/scripts.
- package-lock.json (152KB) vượt trần argv ~95KB của upload_file -> không gửi;
  Vercel tự npm install từ package.json (deps đã pin theo dải tương thích AI SDK v4).
"""
import base64, hashlib, json, os, subprocess, sys, time, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.deploy_state_guardian.json')
VERCEL = '/opt/hatch/bin/vercel'
PROJECT = 'prj_k053ifOFFspQCZ757hXebhX3ePXU'
NAME = 'guardian-ai'
INCLUDE_TOP = {'package.json', 'tsconfig.json', 'next.config.mjs', 'next-env.d.ts'}

def file_set():
    files = []
    for rel in sorted(INCLUDE_TOP):
        if os.path.exists(os.path.join(ROOT, rel)):
            files.append(rel)
    src = os.path.join(ROOT, 'src')
    for dirpath, _dirs, fnames in os.walk(src):
        for f in sorted(fnames):
            files.append(os.path.relpath(os.path.join(dirpath, f), ROOT).replace(os.sep, '/'))
    return sorted(files)

def call(tool, args):
    p = subprocess.run([VERCEL, 'call-tool', '--name', tool, '--arguments-json', json.dumps(args)],
                       capture_output=True, text=True, timeout=300)
    return p.stdout + p.stderr

def main():
    files = file_set()
    meta = {}
    for rel in files:
        data = open(os.path.join(ROOT, rel), 'rb').read()
        assert len(data) < 95000, f'{rel} quá lớn: {len(data)}'
        meta[rel] = (hashlib.sha1(data).hexdigest(), len(data), data)
    print(f'{len(files)} files, tổng {sum(m[1] for m in meta.values())} bytes', flush=True)

    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    todo = [r for r in files if state.get(r) != meta[r][0]]
    print(f'cần upload: {len(todo)} (bỏ qua {len(files) - len(todo)} không đổi)', flush=True)
    for rel in todo:
        sha, size, data = meta[rel]
        out = call('upload_file', {'contentLength': size,
                                   'requestBody': base64.b64encode(data).decode(),
                                   'xVercelDigest': sha})
        if '"ok":true' not in out.replace(' ', ''):
            print(f'UPLOAD FAIL {rel}:\n{out[:800]}'); sys.exit(1)
        state[rel] = sha
        json.dump(state, open(STATE, 'w'), indent=1)
    print('upload xong', flush=True)

    refs = [{'file': r, 'sha': meta[r][0], 'size': meta[r][1]} for r in files]
    out = call('create_deployment', {'requestBody': {'project': PROJECT, 'name': NAME,
                                                     'target': 'production', 'files': refs}})
    m = re.search(r'dpl_[A-Za-z0-9]+', out)
    if not m:
        print('CREATE FAIL:\n' + out[:1500]); sys.exit(1)
    dpl = m.group(0)
    print('deployment:', dpl, flush=True)
    for _ in range(60):
        time.sleep(10)
        out = call('get_deployment', {'idOrUrl': dpl})
        state_str = '?'
        url = ''
        try:
            inner = json.loads(json.loads(out)['result']['content'][0]['text'])
            dep = inner['result']['deployment']
            state_str = dep.get('readyState', '?')
            url = dep.get('url', '')
        except Exception:
            if 'READY' in out: state_str = 'READY'
        print('  status:', state_str, url, flush=True)
        if state_str == 'READY':
            print('DONE', dpl, 'https://' + url if url else ''); return
        if state_str in ('ERROR', 'CANCELED'):
            print('DEPLOY FAIL:\n' + out[:2000]); sys.exit(1)
    print('TIMEOUT chờ READY'); sys.exit(1)

if __name__ == '__main__':
    main()
