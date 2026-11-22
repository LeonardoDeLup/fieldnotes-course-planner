import csv
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app.main import app, CATALOG_PATH, CsvCourseRepository

client = TestClient(app)


def read_rows():
    with CATALOG_PATH.open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def write_rows(path: Path, rows):
    with path.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def test_catalog_preserves_every_source_row():
    response = client.get('/api/courses')
    assert response.status_code == 200
    data = response.json()
    rows = read_rows()
    assert len(data) == len(rows) == 395
    assert len({c['id'] for c in data}) == len(rows)
    assert {(c['code'].replace(' ', '-'), c['title']) for c in data} == {(r['course_code'], r['course_name']) for r in rows}
    assert all(c['description'] for c in data)
    assert all(c['credits'] is not None or c['credit_display'] for c in data)
    assert all(c['source_term'] == 'Spring 2027' for c in data)


def test_credit_ranges_are_displayed_and_not_added_as_fixed_totals():
    course=next(c for c in client.get('/api/courses').json() if c['credit_display']=='2-4')
    assert course['credits'] is None
    assert client.get('/api/courses/'+course['id']).json()['credit_display']=='2-4'

def test_detail_preserves_prerequisites_and_conflict_notes():
    data = client.get('/api/courses/csc-208').json()
    assert data['code'] == 'CSC 208'
    assert 'concurrent' in data['prerequisites']
    assert 'CSC-161PL' in data['system_requisites']
    data = client.get('/api/courses/mus-101').json()
    assert data['prerequisites'] == 'permission of instructor'
    assert data['system_requisites'] == 'None'
    assert 'Description says:' in data['catalog_notes']
    assert client.get('/api/courses/unknown').status_code == 404


def test_distinct_topics_and_lab_suffixes():
    data = client.get('/api/courses').json()
    topics = [c for c in data if c['code'] == 'ADS 295']
    assert len(topics) == len({c['id'] for c in topics}) == 5
    for course in topics:
        assert client.get('/api/courses/'+course['id']).json() == course
    assert client.get('/api/courses/mus-112l').json()['level'] == 100


def test_health():
    assert client.get('/api/health').json() == {'status':'ok', 'data_source':'csv', 'source_file':CATALOG_PATH.name, 'course_count':395}


def test_ids_survive_row_reordering_and_repository_reloads(tmp_path):
    path = tmp_path / 'courses.csv'
    rows = read_rows()
    write_rows(path, rows)
    repo = CsvCourseRepository(path)
    original = {(c.code,c.title):c.id for c in repo.list()}
    write_rows(path, list(reversed(rows)))
    assert {(c.code,c.title):c.id for c in repo.list()} == original
    topic = next(r for r in rows if r['course_code']=='ADS-295')
    write_rows(path, [topic])
    assert repo.list()[0].id == original[(topic['course_code'].replace('-',' '),topic['course_name'])]


def test_missing_columns_and_ambiguous_rows_fail_clearly(tmp_path):
    path = tmp_path / 'bad.csv'
    path.write_text('course_code\nCSC-151\n')
    with pytest.raises(ValueError, match='missing columns'):
        CsvCourseRepository(path)
    row = read_rows()[0]
    write_rows(path, [row,row])
    repo=CsvCourseRepository(path)
    assert len(repo.list())==2
    assert repo.list()[0].id!=repo.list()[1].id


def test_optional_credit_and_description_columns(tmp_path):
    path=tmp_path/'enriched.csv'
    row = {**read_rows()[0], 'credits':'0.5', 'course_description':'A supplied description.'}
    write_rows(path,[row])
    course = CsvCourseRepository(path).list()[0]
    assert course.credits == 0.5
    assert course.description == 'A supplied description.'
    write_rows(path,[{**row,'credits':'0'}])
    assert CsvCourseRepository(path).list()[0].credits == 0
    write_rows(path,[{**row,'credits':'unknown'}])
    with pytest.raises(ValueError):
        CsvCourseRepository(path)
