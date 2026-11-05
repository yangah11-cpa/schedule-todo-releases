// Linux에서 빌드할 때 Wine 없이 exe 아이콘·버전 정보를 넣기 위한 후처리
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const R = ResEdit.default || ResEdit;
  const exeName = ctx.packager.config.win?.executableName || ctx.packager.appInfo.productFilename;
  const exe = path.join(ctx.appOutDir, `${exeName}.exe`);
  const version = ctx.packager.appInfo.version;
  const data = fs.readFileSync(exe);
  const exeFile = R.NtExecutable.from(data, { ignoreCert: true });
  const res = R.NtExecutableResource.from(exeFile);

  const icoFile = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
  const iconId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  R.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    iconId,
    lang,
    icoFile.icons.map((i) => i.data)
  );

  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0] || R.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: '일정 & 할일',
      ProductName: '일정 & 할일',
      CompanyName: '양하승',
      LegalCopyright: '양하승',
      OriginalFilename: `${exeName}.exe`,
      FileVersion: version,
      ProductVersion: version,
    }
  );
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exeFile);
  fs.writeFileSync(exe, Buffer.from(exeFile.generate()));
  console.log('  • exe 아이콘/버전 정보 적용 완료');
};
