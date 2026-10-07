import importlib.util, json, pathlib, tempfile, unittest
spec=importlib.util.spec_from_file_location('release',pathlib.Path(__file__).resolve().parents[1]/'scripts/release.py');release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
class ReleaseTests(unittest.TestCase):
    def test_missing_target_or_signature_prevents_publication(self):
        with tempfile.TemporaryDirectory() as t:
            out=pathlib.Path(t)
            with self.assertRaises(ValueError):release.manifest('1.2.3',out)
    def test_manifest_covers_native_and_flatpak_updates_without_name_collisions(self):
        with tempfile.TemporaryDirectory() as t:
            out=pathlib.Path(t)
            for os,arch,ext in [('linux','x86_64','AppImage'),('darwin','x86_64','app.tar.gz'),('darwin','aarch64','app.tar.gz'),('windows','x86_64','exe'),('linux-flatpak','x86_64','flatpak')]:
                name=release.artifact_name('1.2.3',os,arch,ext);(out/name).write_bytes(b'fixture');(out/(name+'.sig')).write_text('signature\n')
            feed=release.manifest('1.2.3',out,'Changes')
            self.assertEqual(len(feed['platforms']),5)
            self.assertEqual(len({p['url'] for p in feed['platforms'].values()}),5)
            self.assertTrue(all('/releases/download/v1.2.3/' in p['url'] for p in feed['platforms'].values()))
    def test_tag_must_match_application_versions(self):
        with self.assertRaises(ValueError):release.version('v999.0.0')
        with self.assertRaises(ValueError):release.version('main')
    def test_checksums_cover_manifest_and_installers(self):
        with tempfile.TemporaryDirectory() as t:
            out=pathlib.Path(t);(out/'latest.json').write_text('{}');(out/'app.rpm').write_bytes(b'rpm')
            release.checksums(out);lines=(out/'SHA256SUMS').read_text().splitlines()
            self.assertEqual(len(lines),2);self.assertTrue(lines[0].endswith('app.rpm'));self.assertTrue(lines[1].endswith('latest.json'))
if __name__=='__main__':unittest.main()
