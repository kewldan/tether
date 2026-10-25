#!/usr/bin/env python3
"""Prints the visible text of a design board (docs/design/project/*.dc.html).

Usage: python3 scripts/design-text.py docs/design/project/Files.dc.html
"""

import re,sys,html
s=open(sys.argv[1]).read()
s=re.sub(r'<helmet>.*?</helmet>','',s,flags=re.S)
s=re.sub(r'<svg.*?</svg>','',s,flags=re.S)
s=re.sub(r'<(br|/div|/tr|/h\d|/p|/li|/pre|/button)[^>]*>','\n',s)
s=re.sub(r'<[^>]+>',' ',s)
s=html.unescape(s)
s=re.sub(r'[ \t]+',' ',s); s=re.sub(r'\n\s*\n+','\n',s)
print(s)
