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


def test_full_plan_fills_eight_terms_and_sequences_new_prerequisites(monkeypatch):
    with advisor_client() as client:
        revision, plan = catalog_and_plan(client, [
            {'courseId': 'csc-151', 'semesterId': 'semester-0'},
        ])
        ranked_choices = []

        async def rank(action, context, choices):
            assert action == 'generate_full_plan'
            assert all(len(choice['semesters']) == 8 for choice in context['choices'])
            ranked_choices.extend(reversed(choices))
            return ranked_choices.copy(), None

        monkeypatch.setattr(app.state.ollama, 'rank', rank)
        response = client.post('/api/ai/advice', json={
            'action': 'generate_full_plan', 'catalogRevision': revision, 'plan': plan,
            'options': {'focusDepartments': ['CSC']},
        })
        assert response.status_code == 200
        result = response.json()
        assert result['mode'] == 'model'
        assert [proposal['id'] for proposal in result['proposals']] == ranked_choices
        assert len(ranked_choices) == 2
        for proposal in result['proposals']:
            assert [total['semesterId'] for total in proposal['totals']] == [
                f'semester-{i}' for i in range(8)
            ]
            assert all(total['after'] == 16 for total in proposal['totals'])
            assert proposal['totals'][0]['before'] == 4
            ids = [action['courseId'] for action in proposal['actions']]
            assert 'csc-151' not in ids and len(ids) == len(set(ids))
            assert all(action['kind'] == 'add' for action in proposal['actions'])
        focused = next(p for p in result['proposals'] if p['id'] == 'full-focus')
        terms = {a['courseId']: a['semesterId'] for a in focused['actions']}
        assert 'semester-0' < terms['csc-161'] < terms['csc-207']


def test_full_plan_preserves_unknown_and_already_full_terms(monkeypatch):
    monkeypatch.setenv('FIELDNOTES_AI_ENABLED', '0')
    with advisor_client() as client:
        revision, plan = catalog_and_plan(client, [
            {'courseId': 'unavailable-saved-course', 'semesterId': 'semester-0'},
            {'courseId': 'csc-151', 'semesterId': 'semester-1'},
            {'courseId': 'csc-105', 'semesterId': 'semester-1'},
        ])
        response = client.post('/api/ai/advice', json={
            'action': 'generate_full_plan', 'catalogRevision': revision, 'plan': plan,
            'options': {'targetCredits': 4},
        })
        assert response.status_code == 200
        proposal = response.json()['proposals'][0]
        assert proposal['totals'][:2] == [
            {'semesterId': 'semester-0', 'before': None, 'after': None},
            {'semesterId': 'semester-1', 'before': 8, 'after': 8},
        ]
        assert all(action['semesterId'] not in {'semester-0', 'semester-1'}
                   for action in proposal['actions'])
        assert all(total['after'] == 4 for total in proposal['totals'][2:])


def test_all_full_plan_drafts_build_sequences_in_requested_departments(monkeypatch):
    monkeypatch.setenv('FIELDNOTES_AI_ENABLED', '0')
    with advisor_client() as client:
        catalog = client.get('/api/courses')
        by_id = {row['id']: row for row in catalog.json()}
        ant_104 = next(row['id'] for row in by_id.values() if row['code'] == 'ANT 104')
        revision, plan = catalog_and_plan(client, [
            {'courseId': ant_104, 'semesterId': 'semester-0'},
        ])
        response = client.post('/api/ai/advice', json={
            'action': 'generate_full_plan', 'catalogRevision': revision, 'plan': plan,
            'options': {'focusDepartments': ['MAT', 'CSC', 'STA'], 'goals': 'Applied data science'},
        })
        assert response.status_code == 200
        proposals = response.json()['proposals']
        assert len(proposals) == 2
        for proposal in proposals:
            courses = [(by_id[action['courseId']], action['semesterId']) for action in proposal['actions']]
            terms = {course['code']: term for course, term in courses}
            assert len(terms) == len(courses)
            assert 'ANT 104' not in terms
            assert sum(course['credits'] for course, _ in courses if course['department'] in {'MAT', 'CSC', 'STA'}) >= 96
            assert 'MAT 314' not in terms and 'STA 336' not in terms
            assert not {'CSC 208', 'MAT 208'} <= terms.keys()
            assert terms['MAT 131'] < terms['MAT 133'] < terms['MAT 215'] < terms['MAT 218'] < terms['MAT 316']
            assert terms['CSC 151'] < terms['CSC 161'] < terms['CSC 207'] < terms['CSC 324']
            if 'CSC 326' in terms:
                assert terms['CSC 324'] < terms['CSC 326']
            assert terms['STA 209'] < terms['STA 230'] < terms['STA 330']
            assert terms['CSC 207'] < terms['STA 330']
            assert all(total['after'] == 16 for total in proposal['totals'])
            assert proposal['totals'][0]['before'] == 4
            assert next(p for p in proposal['placements'] if p['courseId'] == 'mat-131')['requisiteStatus'] == 'needs_review'
            assert any(notice.startswith('Proposed courses by focus department') for notice in proposal['notices'])

