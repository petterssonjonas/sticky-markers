#!/usr/bin/env python3
"""Exercise the real stdio server, disk persistence, retries, and scope enforcement."""
import json, os, pathlib, subprocess, sys, tempfile
binary = pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'target/debug/sticky-markers-mcp').resolve()
with tempfile.TemporaryDirectory() as tmp:
    root=pathlib.Path(tmp); vault=root/'vault';vault.mkdir();data=root/'data';data.mkdir()
    (data/'settings.json').write_text(json.dumps({'vaults':[{'id':'smoke','name':'Smoke','path':str(vault),'github':None}],'activeVault':'smoke'}))
    p=subprocess.Popen([str(binary),'--data-dir',str(data),'--vault','smoke'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    seq=0
    def rpc(method,params):
        global seq
        seq+=1;p.stdin.write(json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params})+'\n');p.stdin.flush()
        while True:
            line=p.stdout.readline()
            if not line: raise RuntimeError(p.stderr.read())
            r=json.loads(line)
            if r.get('id')==seq:
                assert 'error' not in r,r
                return r['result']
    info=rpc('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'sticky-smoke','version':'1'}})
    assert info['capabilities']['tools'] is not None
    p.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');p.stdin.flush()
    tools=rpc('tools/list',{})['tools'];assert len(tools)>=6
    def tool(name,args): return rpc('tools/call',{'name':name,'arguments':args})
    def document(r): assert not r.get('isError'),r;return json.loads(r['content'][0]['text'])
    n=document(tool('create_note',{'vault_id':'smoke','path':'Voice.md','content':'# Dictated note\n','request_id':'create-1'}))
    again=document(tool('create_note',{'vault_id':'smoke','path':'Voice.md','content':'# Dictated note\n','request_id':'create-1'}));assert n==again
    args={'vault_id':'smoke','path':'Voice.md','expected_revision':n['revision'],'content':'A spoken paragraph.\n','request_id':'append-1'}
    appended=document(tool('append_note',args));assert document(tool('append_note',args))==appended
    assert (vault/'Voice.md').read_text()=='# Dictated note\nA spoken paragraph.\n'
    stale=tool('update_note',{'vault_id':'smoke','path':'Voice.md','expected_revision':n['revision'],'content':'stale','request_id':'edit-stale'});assert stale['isError']
    denied=tool('read_note',{'vault_id':'unauthorized','path':'Voice.md'});assert denied['isError']
    escape=tool('create_note',{'vault_id':'smoke','path':'../escape.md','content':'x','request_id':'escape'});assert escape['isError']
    read=document(tool('read_note',{'vault_id':'smoke','path':'Voice.md'}));assert read['content']==appended['content']
    p.stdin.close();p.wait(timeout=5);assert p.returncode==0
    print('MCP smoke passed: negotiation, tools, disk writes, retries, stale revisions, scopes, path containment.')
