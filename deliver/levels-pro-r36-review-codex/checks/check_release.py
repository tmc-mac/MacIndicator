from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
import importlib.util
p=str(ROOT / 'source/tools/pinei2.py')
s=importlib.util.spec_from_file_location('pinei2',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def obj(typ,**kw):
 d={k:None for k,_ in m.UDT[typ]};d.update(kw);return m.UObj(typ,d)
def case(enabled=True,advance=60,change_period=False,opened=False):
 gl={'td_climax':True,'td_release':enabled,'td_control_bias':True,'td_control_free':True,'td_lane_accept':True,'td_wave_trend':True,'td_stale_r':2.0}
 i=m.load(str(ROOT / 'LevelsPRO-TIDE-r155-partial-review.pine'),{'globals':gl});T=1793815200
 g=i.g.v['G'];g.f.update(pT=T-4000,cDir=1,cKind='trap',clDir=0,seq=0,msK=True,ms='TREND',nsUp=None)
 z=obj('TZone',key='old',nm='old',p=100,lo=98,hi=102,t4=True,o4=False,src='board')
 new=obj('TZone',key='new',nm='new',p=110,lo=108,hi=112,t4=False,o4=False,src='board')
 old=obj('TSet',id='S0',stat=0,dir=1,ent=(T-1 if opened else None),clo=None,kind=0,lvl=100,ext=80,rno=0,ukey='old',z=z,zs='|old|',s4=True,armT=T-600,swT=T-900,legT=T-300,dbody=.8,dxa=1.5)
 ep=obj('TEp',side=1,st=T-300,n=2,disp=True,breakBody=.7,breakXavg=1.2)
 b=obj('TBar',t=T-60,o=100,h=110,l=90,c=100,v=1)
 i.g.v['SU']=m.PI.Arr([old]);i.g.v['M1']=m.PI.Arr([b]);i.call_fn('t_armA',[new,ep,False,T])
 pending=i.g.v['PA_E'].v[0] is not None
 assert pending==(enabled and not opened),(enabled,opened,pending)
 if opened:return
 old.f['stat']=2;old.f['rno']=1
 if change_period:g.f['pT']-=14400
 if advance>1800:i.g.v['PA_T'].v[0]-=advance
 i.call_fn('t_emit',[old,b,T+60])
 fresh=[x for x in i.g.v['SU'].v if x.f['kind']==1 and x.f['stat']==0]
 expected=enabled and not change_period and advance<=36*300
 assert bool(fresh)==expected,(enabled,advance,change_period,old,fresh)
 assert (old.f['stat']==3)==enabled,(enabled,old)
for args in [(True,60,False,False),(True,20000,False,False),(True,60,True,False),(False,60,False,False),(True,60,False,True)]:case(*args)
print('5 pending-acceptance/release synthetic checks passed')
# A missing structural stop cannot consume a zone or become a chart signal.
i=m.load(str(ROOT / 'LevelsPRO-TIDE-r155-partial-review.pine'),{'globals':{'td_climax':True,'td_release':False,'td_control_bias':True,'td_control_free':True,'td_lane_accept':True,'td_wave_trend':True,'td_stale_r':2.0}})
T=1793815200;g=i.g.v['G'];g.f.update(pT=T-4000,cDir=1,cKind='trap',clDir=0,msK=True,ms='TREND',nsUp=None)
z=obj('TZone',key='z',nm='z',p=100,lo=98,hi=102,t4=True,o4=False,src='board')
s=obj('TSet',stat=2,dir=1,ent=None,clo=None,kind=0,lvl=100,ext=None,rno=1,ukey='stop-na',z=z,s4=True,armT=T-600,swT=T-900,legT=T-300,dbody=.8,dxa=1.5)
b=obj('TBar',t=T-60,o=100,h=110,l=90,c=100,v=1)
i.g.v['BRT']=m.PI.Arr([T-450]);i.g.v['BR15']=m.PI.Arr([.4]);i.g.v['BR30']=m.PI.Arr([.4]);i.call_fn('t_emit',[s,b,T])
assert s.f['ent'] is None and 'stop-na' not in i.g.v['USED'].v and s.f['why']=='no logical stop',s
print('1 missing-stop correctness check passed')
