from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
import importlib.util
p=str(ROOT / 'source/tools/pinei2.py')
s=importlib.util.spec_from_file_location('pinei2',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
i=m.load(str(ROOT / 'LevelsPRO-TIDE-r155-partial-review.pine'), {'globals':{'td_release':True,'td_control_bias':True,'td_control_free':True,'td_lane_accept':True,'td_wave_trend':True}})
cases=[((159,100,80,0,2),False),((160,100,80,0,2),False),((160.25,100,80,0,2),True),((200,100,60,0,2),True),((180,100,60,0,2),False),((200,100,80,1,2),False),((200,100,100,0,2),False),((200,100,80,0,0),False)]
for args,want in cases:
    got=i.call_fn('t_farTrap',list(args));assert got==want,(args,got,want)
print(len(cases),'rule 18 threshold checks passed (synthetic, interpreter)')
def obj(typ, **kw):
    d={k:None for k,_ in m.UDT[typ]};d.update(kw);return m.UObj(typ,d)
def arm_case(px, trap_level, trap_ext, retests, new_level, multiplier, expected_cancel):
    i.g.v['td_stale_r']=multiplier
    g=i.g.v['G'];g.f.update(pT=100,cDir=0,cKind='',clDir=0,seq=0)
    oldz=obj('TZone',key='old',nm='old',p=trap_level,t4=False)
    newz=obj('TZone',key='new',nm='new',p=new_level,t4=False,o4=False)
    old=obj('TSet',stat=0,dir=1,ent=None,kind=0,lvl=trap_level,ext=trap_ext,rno=retests,ukey='old',z=oldz,zs='|old|')
    e=obj('TEp',side=1,st=100,n=2,disp=True)
    i.g.v['SU']=m.PI.Arr([old]);i.g.v['USED']=m.PI.Arr([]);i.g.v['M1']=m.PI.Arr([obj('TBar',c=px)])
    i.call_fn('t_armA',[newz,e,False,200])
    assert (old.f['stat']==3)==expected_cancel,(px,new_level,old)
    assert (len(i.g.v['SU'].v)==2)==expected_cancel,(px,new_level,i.g.v['SU'].v)
for c in [(200,100,80,0,190,2,True),(160,100,80,0,150,2,False),(200,100,80,1,190,2,False),(200,100,80,0,50,2,False),(200,100,80,0,190,0,False)]:arm_case(*c)
print('5 rule 18 arm/replacement checks passed (synthetic, interpreter)')
