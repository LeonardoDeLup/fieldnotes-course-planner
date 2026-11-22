from fastapi.testclient import TestClient
from app.main import app

def advisor_client():
    return TestClient(app)

def catalog_and_plan(client, entries):
    response=client.get('/api/courses')
    return response.headers['x-catalog-revision'], {'version':1,'startYear':2026,'entries':entries}

def test_revision_header_and_strict_request_validation():
    with advisor_client() as client:
        revision,plan=catalog_and_plan(client,[])
        assert len(revision)==64
        request={'action':'critique_plan','catalogRevision':revision,'plan':plan,'options':{'targetCredits':16,'focusDepartments':[],'goals':''}}
        assert client.post('/api/ai/advice',json=request).status_code==200
        changed={**request,'catalogRevision':'0'*64}
        response=client.post('/api/ai/advice',json=changed)
        assert response.status_code==409 and response.json()['detail']['code']=='catalog_changed'
        malformed={**request,'options':{'targetCredits':16,'focusDepartments':[],'goals':'','surprise':True}}
        assert client.post('/api/ai/advice',json=malformed).status_code==422
        duplicate={'version':1,'startYear':2026,'entries':[{'courseId':'csc-151','semesterId':'semester-0'},{'courseId':'csc-151','semesterId':'semester-1'}]}
        assert client.post('/api/ai/advice',json={**request,'plan':duplicate}).status_code==422

def test_generate_bundles_chm_lab_and_keeps_existing_placements():
    with advisor_client() as client:
        revision,plan=catalog_and_plan(client,[{'courseId':'csc-151','semesterId':'semester-0'},{'courseId':'csc-161','semesterId':'semester-1'}])
        request={'action':'generate_semester','catalogRevision':revision,'plan':plan,'options':{'semesterId':'semester-1','targetCredits':8,'focusDepartments':['CHM'],'goals':'chemistry','allowRequisiteReview':False}}
        response=client.post('/api/ai/advice',json=request)
        assert response.status_code==200
        proposals=response.json()['proposals']
        chemistry=next(p for p in proposals if [a['courseId'] for a in p['actions']]==['chm-129','chm-129l'])
        assert chemistry['totals']==[{'semesterId':'semester-1','before':4.0,'after':8.0}]
        assert chemistry['placements'][0]['availability']=='listed_in_source_term'
        assert chemistry['placements'][1]['requisiteStatus']=='no_issue_in_plan'
        assert all(a['semesterId']=='semester-1' for p in proposals for a in p['actions'])

def test_critique_finds_sequence_gap_and_verified_move():
    with advisor_client() as client:
        revision,plan=catalog_and_plan(client,[{'courseId':'csc-161','semesterId':'semester-0'},{'courseId':'csc-151','semesterId':'semester-1'}])
        request={'action':'critique_plan','catalogRevision':revision,'plan':plan,'options':{'targetCredits':16,'focusDepartments':[],'goals':''}}
        response=client.post('/api/ai/advice',json=request)
        assert response.status_code==200
        result=response.json()
        finding=next(f for f in result['findings'] if f['code']=='sequence_gap')
        assert 'CSC-151 - Must be completed prior' in finding['evidence'][1]['excerpt']
        proposal=next(p for p in result['proposals'] if p['id']==finding['proposalId'])
        assert proposal['actions']==[{'kind':'move','courseId':'csc-161','semesterId':'semester-2','fromSemesterId':'semester-0'}]
        assert proposal['placements'][0]['availability']=='term_unverified'

