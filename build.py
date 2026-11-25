from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
(root / '.build').mkdir(exist_ok=True)
subprocess.run([
    'tsc', str(root / 'src' / 'app.ts'),
    '--target', 'ES2020',
    '--lib', 'ES2020,DOM',
    '--module', 'none',
    '--strict',
    '--skipLibCheck',
    '--outFile', str(root / '.build' / 'app.js')
], check=True)
html = (root / 'index.template.html').read_text()
script = (root / '.build' / 'app.js').read_text().replace('</script', '<\\/script')
(root / 'index.html').write_text(html.replace('/*__APP_JS__*/', script))
print(root / 'index.html')
