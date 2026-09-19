import {run,scrubbedEnv,executable as findExecutable} from './process.mjs';

export const CODEX_SIGN_IN='Sign in to Codex in Terminal';
/** Installed and signed in, judged by exit codes only: login output is discarded, never parsed. */
export async function codexReadiness({executable=findExecutable('codex'),run:exec=run}={}){
  let binary;
  try{binary=await executable;}catch(error){return {installed:false,ready:false,error:error.message};}
  const options={env:scrubbedEnv(),timeout:5000,maxBytes:20_000};
  let version;
  try{version=(await exec(binary,['--version'],options)).stdout.trim().replace(/^codex(-cli)?\s+/,'')||undefined;}
  catch(error){return {installed:true,ready:false,error:`Codex did not report its version. ${error.message}`};}
  try{await exec(binary,['login','status'],options);return {installed:true,ready:true,version};}
  catch{return {installed:true,ready:false,version,error:CODEX_SIGN_IN};}
}
