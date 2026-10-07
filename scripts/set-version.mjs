import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const version=process.argv[2];
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version??"")) throw new Error("Usage: node scripts/set-version.mjs MAJOR.MINOR.PATCH");
const files=["package.json","package-lock.json","Cargo.toml","Cargo.lock","src-tauri/tauri.conf.json"];
const originals=new Map(files.map(f=>[f,readFileSync(f,"utf8")]));
try {
  for(const file of ["package.json","package-lock.json","src-tauri/tauri.conf.json"]){
    const data=JSON.parse(originals.get(file));data.version=version;
    if(data.packages?.[""])data.packages[""].version=version;
    writeFileSync(file,JSON.stringify(data,null,2)+"\n");
  }
  writeFileSync("Cargo.toml",originals.get("Cargo.toml").replace(/(\[workspace\.package\]\s*\nversion\s*=\s*)"[^"]+"/,`$1"${version}"`));
  execFileSync("cargo",["update","--workspace","--offline"],{stdio:"inherit"});
  console.log(`Set application versions to ${version}. Review and commit; this does not tag or publish anything.`);
}catch(error){for(const [file,content] of originals)writeFileSync(file,content);throw error;}
