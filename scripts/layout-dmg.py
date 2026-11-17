#!/usr/bin/env python3
"""在挂载卷内写入 Finder 安装窗口布局，无需控制用户的 Finder。"""
import sys
from pathlib import Path

from ds_store import DSStore, DSStoreEntry
from mac_alias import Alias

volume = Path(sys.argv[1]).resolve()
background = volume / '.background' / 'background.tiff'
reference = sys.argv[2]
with DSStore.open(str(volume / '.DS_Store'), 'w+') as store:
    store['.']['bwsp'] = {
        'WindowBounds': '{{220, 150}, {720, 460}}',
        'ShowToolbar': False, 'ShowStatusBar': False, 'ShowSidebar': False,
        'ShowTabView': False, 'ShowPathbar': False, 'ContainerShowSidebar': False,
    }
    store['.']['icvp'] = {
        'viewOptionsVersion': 1, 'backgroundType': 2,
        'backgroundColorRed': 1.0, 'backgroundColorGreen': 1.0, 'backgroundColorBlue': 1.0,
        'backgroundImageAlias': Alias.for_file(str(background)).to_bytes(),
        'iconSize': 96.0, 'textSize': 13.0, 'labelOnBottom': True,
        'showItemInfo': False, 'showIconPreview': True, 'arrangeBy': 'none',
        'gridOffsetX': 0.0, 'gridOffsetY': 0.0, 'gridSpacing': 100.0,
        'scrollPositionX': 0.0, 'scrollPositionY': 0.0,
    }
    store['.']['vSrn'] = ('long', 1)
    store['.']['icvl'] = ('type', b'icnv')
    # 新版 Finder 优先读取背景 bookmark，同时保留旧版 Alias 兼容。
    store.insert(DSStoreEntry('.', 'pBBk', 'blob', Path(reference + '.bookmark').read_bytes()))
    store['PP Clash.app']['Iloc'] = (184, 252)
    store['Applications']['Iloc'] = (536, 252)

with DSStore.open(str(volume / '.DS_Store'), 'r') as store:
    assert store['PP Clash.app']['Iloc'] == (184, 252)
    assert store['Applications']['Iloc'] == (536, 252)
    assert store['.']['icvp']['backgroundType'] == 2
print('Finder 布局已写入并验证：720 × 460，96 px 图标，背景与拖入指引。')
