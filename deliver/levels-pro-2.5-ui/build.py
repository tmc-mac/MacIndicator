#!/usr/bin/env python3
# Builds LEVELS PRO v2.5-ui from the baseline Mac pasted (v2.4-dev).
# Only the dashboard section (13) is touched: it is cut out and re-emitted at the
# end of the file as section 16, so new inputs sit after every existing input.
import re, sys, hashlib

src, out = sys.argv[1], sys.argv[2]
L = open(src, encoding='utf-8').read().split('\n')

def idx(prefix, start=0):
    for i in range(start, len(L)):
        if L[i].startswith(prefix):
            return i
    raise SystemExit('not found: ' + prefix)

h13 = idx('// 13. DASHBOARD')            # header text line
h14 = idx('// 14. ALERTS')
s13, e13 = h13 - 1, h14 - 1              # the '// ====' rule lines above each header
assert L[s13].startswith('// ====') and L[e13].startswith('// ====')
sec = L[s13:e13]

def sidx(prefix):
    for i, l in enumerate(sec):
        if l.startswith(prefix):
            return i
    raise SystemExit('not found in 13: ' + prefix)

prelude = sec[sidx('panel_pos = dash_pos'): sidx('NCOL = mobile ? 3 : 6') + 1]
mob_a, mob_b = sidx('    // ----------------------------- MOBILE'), sidx('    // ----------------------------- DESKTOP')
mobile = sec[mob_a + 1: mob_b]          # starts at '    if mobile'
assert mobile[0] == '    if mobile', mobile[0]
lad_a = sidx('    // ----------------- LEVEL LADDER')
ladder = '\n'.join(sec[lad_a:]).rstrip('\n')
mobile = '\n'.join(mobile).rstrip('\n')

def sub1(text, old, new, count=1):
    assert text.count(old) == count, (text.count(old), old[:70])
    return text.replace(old, new)

# ---- mobile patches: feed status in the title, optional TAPE row ----
old = '        table.cell(T, 2, r, grade_str, text_color=grade_col, text_size=cell_sz, bgcolor=col_bgttl, text_halign=text.align_right)\n'
mobile = sub1(mobile, old, old + '        table.cell(T, 1, r, ui_status ? feed_txt : "", tooltip=feed_tip, text_color=feed_col, text_size=cell_sz, bgcolor=col_bgttl, text_halign=text.align_left)\n')
old = '        // v2.3 EVENT feed, mobile form: the single latest event\n'
tape_m = '''        // v2.5 TAPE row, mobile form: relative volume + effort vs result
        if ui_tape
            f_blank(r, col_bg2)
            table.cell(T, 0, r, "TAPE", text_color=txt_mid, text_size=cell_sz, bgcolor=col_bg2, text_halign=text.align_left)
            table.cell(T, 1, r, tape_rv_s, tooltip=tape_tip, text_color=rvol_col, text_size=cell_sz, bgcolor=col_bg2, text_halign=text.align_left)
            table.cell(T, 2, r, tape_ef_s, tooltip=tape_tip, text_color=effort_col, text_size=cell_sz, bgcolor=col_bg2, text_halign=text.align_right)
            r += 1

'''
mobile = sub1(mobile, old, tape_m + old)
# keep the zebra after the optional row: EV row background follows it
# (EV row stays col_bg2 as in the baseline; TAPE uses the same tone on purpose.)

# ---- ladder patches ----
old = '''        if not na(px) and array.get(L_ON, i)
            array.push(ord, i)
'''
ladder = sub1(ladder, old, '''        if not na(px) and array.get(L_ON, i) and math.abs(close - px) <= dcut
            array.push(ord, i)
''')
old = '            string nm = (isip ? "> " : "") + array.get(L_NAME, i) + array.get(L_MRG, i) + (array.get(TESTED, i) ? "" : " *")\n'
ladder = sub1(ladder, old, old + '            string lv_tip = array.get(L_NAME, i) + array.get(L_MRG, i) + "\\n" + (array.get(L_TIER, i) == 3 ? "Weekly level" : array.get(L_TIER, i) == 2 ? "Daily level" : "Session level") + "  |  weight " + str.tostring(array.get(L_IMP, i), "0.0") + "\\nTouches: " + str.tostring(array.get(TOUCH, i)) + (array.get(TESTED, i) ? "" : "  (untested *)") + "\\n" + str.tostring(math.abs(dpt) / atr_ref, "0.00") + " x 1H ATR from price"\n')
old = '                table.cell(T, 0, r, nm, text_color=isip ? col_viol : f_ctl_col(cs), text_size=cell_sz, bgcolor=rbg, text_halign=text.align_left)\n'
ladder = sub1(ladder, old, old.replace('r, nm, text_color', 'r, nm, tooltip=lv_tip, text_color'))
# PRICE marker rows (two places): add the push read and span it
pat = re.compile(r'^( +)(table\.cell\(T, 1, r, str\.tostring\(close, format\.mintick\), text_color=col_viol, .*\))$', re.M)
assert len(pat.findall(ladder)) == 2
ladder = pat.sub(lambda m: m.group(0) + '\n' + m.group(1) + 'table.cell(T, 2, r, px_push_s, text_color=px_push_c, text_size=cell_sz, bgcolor=col_pxbg, text_halign=text.align_right)\n' + m.group(1) + 'f_span(r, 2, 5)', ladder)
# hidden-level note + CONFLUENCE span
old = '''    if not mobile
        f_blank(r, col_bgdiv)
        table.cell(T, 0, r, "  CONFLUENCE"'''
ladder = sub1(ladder, old, '''    if not mobile and n_all > n
        f_blank(r, col_bg)
        table.cell(T, 0, r, "  +" + str.tostring(n_all - n) + " farther levels hidden", text_color=txt_lo, text_size=cell_sz, bgcolor=col_bg, text_halign=text.align_left)
        f_span(r, 0, 5)
        r += 1

''' + old)
ladder += '\n        f_span(r, 1, 4)'

new = open(sys.argv[3], encoding='utf-8').read().rstrip('\n')
new = sub1(new, '@@PRELUDE@@', '\n'.join(prelude))
new = sub1(new, '@@MOBILE@@', mobile)
new = sub1(new, '@@LADDER@@', ladder)

stub = [
 '// ===========================================================================',
 '// 13. DASHBOARD  -  moved to section 16 (v2.5-ui)',
 '// The dashboard is drawn at the END of the script so its new display inputs',
 '// sit after every existing input (no existing input changes position) and so',
 '// it can show the feed status computed in section 15. Nothing in sections',
 '// 14 or 15 ever read anything from the dashboard.',
 '// ===========================================================================',
 '', '']
body = L[:s13] + stub + L[e13:]
while body and body[-1] == '':
    body.pop()
hdr = [
 '// v2.5-ui (11/11, MacArthur desk): DASHBOARD DISPLAY ONLY on top of the v2.4-dev build Mac named the best-looking baseline.',
 '//   UNCOMPILED - no Pine compiler on the desk; the TradingView compile governs. No level, score, plan, grade, signal, alert,',
 '//   line, label, glyph or PARITY / EVENTS table row changed. Section 13 (dashboard) moved to section 16 at the end of the file.',
 '//   New code is tagged [UI5]. See section 16 for the list.',
]
assert body[0].startswith('//@version=5')
body = [body[0]] + hdr + body[1:]
text = '\n'.join(body) + '\n\n\n' + new + '\n'
# ---- rename (Mac 11/11): MacMillionz Levelz Indicator. Display names only; the PARITY "SCRIPT" row and alert texts keep their old strings. ----
def one(t, a, b):
    assert t.count(a) == 1, (t.count(a), a)
    return t.replace(a, b)
text = one(text, 'indicator("Daily Levels PRO v2.4-dev - Scalp Engine", shorttitle="LEVELS PRO v2.4-dev"', 'indicator("MacMillionz Levelz Indicator", shorttitle="MacMillionz Levelz"')
text = one(text, 'table.cell(T, 0, r, "LEVELS PRO", text_color=color.white', 'table.cell(T, 0, r, "MACMILLIONZ LEVELZ", text_color=color.white')
text = one(text, 'table.cell(T, 0, r, "LEVELS", text_color=color.white', 'table.cell(T, 0, r, "LEVELZ", text_color=color.white')
open(out, 'w', encoding='utf-8').write(text)
print('lines', text.count('\n'), 'sha256', hashlib.sha256(text.encode()).hexdigest()[:16])
