#!/usr/bin/env python3
"""Bundle official local OpenAPI YAML references without network access.
Usage: python scripts/build-catalog.py ../api-specs
Requires PyYAML only when refreshing the bundled catalog.
"""
import json, pathlib, sys, subprocess, hashlib, datetime
import yaml
source = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(__file__).resolve().parents[1] / 'resources'
VERSIONS = ['v2026', 'v2025', 'v2024', 'v3', 'beta']
cache = {}
def read(path):
    if path not in cache:
        cache[path] = yaml.safe_load(path.read_text())
    return cache[path]

def bundle(path):
    defs, refs = {}, {}
    def walk(value, current):
        if isinstance(value, list): return [walk(v, current) for v in value]
        if not isinstance(value, dict): return value
        result = {}
        for k, v in value.items():
            if k != '$ref': result[k] = walk(v, current); continue
            filename, _, pointer = v.partition('#')
            if '://' in filename: raise ValueError('Remote ref prohibited: ' + v)
            target = (current.parent / filename).resolve() if filename else current
            target.relative_to(source)
            key = (str(target), pointer)
            if key not in refs:
                name = 's' + str(len(refs)); refs[key] = name; defs[name] = {}
                obj = read(target)
                if pointer:
                    for part in pointer.lstrip('/').split('/'):
                        obj = obj[part.replace('~1','/').replace('~0','~')]
                defs[name] = walk(obj, target)
            result[k] = '#/$defs/' + refs[key]
        return result
    result = walk(read(path), path)
    result['$defs'] = defs
    return result

def resolve(spec, value):
    seen = set()
    while isinstance(value, dict) and '$ref' in value:
        ref = value['$ref']
        if ref in seen: raise ValueError('Circular non-schema ref: ' + ref)
        seen.add(ref)
        value = spec
        for part in ref[2:].split('/'): value = value[part.replace('~1','/').replace('~0','~')]
    return value

catalog = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'source': 'https://github.com/sailpoint-oss/api-specs', 'commit': subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip(), 'versions': {}, 'operations': []}
for version in VERSIONS:
    spec = bundle(source / 'idn' / ('sailpoint-api.' + version + '.yaml'))
    encoded = json.dumps(spec, separators=(',',':'), default=str).encode()
    (out / (version + '.json')).write_bytes(encoded)
    count = 0
    for path, raw in spec['paths'].items():
        item = resolve(spec, raw)
        for method, rawop in item.items():
            if method not in ['get','post','put','patch','delete','head','options','trace']: continue
            op = resolve(spec, rawop)
            catalog['operations'].append({'key': version + ':' + method + ':' + path, 'version':version, 'method':method.upper(), 'path':path, 'operationId':op.get('operationId',''), 'summary':op.get('summary', path), 'tags':op.get('tags',['Other']), 'deprecated':op.get('deprecated',False)})
            count += 1
    catalog['versions'][version] = {'operations':count, 'sha256':hashlib.sha256(encoded).hexdigest()}
(out / 'catalog.json').write_text(json.dumps(catalog,separators=(',',':')))
(out / 'SAILPOINT-SPEC-LICENSE.txt').write_text((source / 'LICENSE').read_text())
print(json.dumps({v:d['operations'] for v,d in catalog['versions'].items()},indent=2))
