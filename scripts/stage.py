"""Overlay only a disposable runtime inside this repository; never edit real pi."""
from pathlib import Path
import os, shutil
root=Path(__file__).resolve().parents[1]
pi=Path(os.environ.get('PI_SOURCE',str(root/'.runtime/pi'))).resolve()
if not pi.is_relative_to((root/'.runtime').resolve()):
    raise SystemExit('PI_SOURCE must be disposable under cuse/.runtime')
dest=pi/'packages/coding-agent/src/cuse'
dest.mkdir(parents=True,exist_ok=True)
for source in (root/'src').glob('*.ts'): shutil.copyfile(source,dest/source.name)
print('Staged runtime in',dest)
