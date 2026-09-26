/** One teaching entry point with browser and macOS adapters. */
export function createTeaching({desktop,browser,onChange=()=>{}}){
  let mode='desktop',switching=false,generation=0;
  const selected=()=>mode==='desktop'?desktop:browser;
  const brief=()=>({...selected().brief(),mode});
  const read=async()=>{const capturedMode=mode,adapter=selected();return {...await adapter.read(),mode:capturedMode};};
  const cancel=async()=>{generation++;switching=false;await Promise.allSettled([desktop.cancel(),browser.cancel()]);};
  async function action(name,input={}){
    if(name==='cancel'){await cancel();return read();}
    if(switching)throw new Error('Summon is changing teaching modes. Try again in a moment.');
    if(name==='mode'){
      if(!['desktop','browser'].includes(input.mode))throw new Error('Choose Mac apps or a browser tab.');
      if(['recording','reviewing','running','proposal'].includes(selected().brief().phase))throw new Error('Stop the current teaching session before changing modes.');
      const ticket=++generation,previous=selected();switching=true;
      try{
        if(input.mode!==mode){await previous.cancel();if(ticket!==generation)return read();mode=input.mode;onChange();}
        await selected().action('connect');return read();
      }finally{if(ticket===generation)switching=false;}
    }
    await selected().action(name,input);return read();
  }
  return {read,brief,action,handles:text=>switching||selected().handles(text),command:text=>switching?Promise.resolve({kind:'message',message:'Summon is changing teaching modes. Try again in a moment.'}):selected().command(text),
    connectionChanged:()=>browser.connectionChanged(),
    cancel,
    close:async()=>{await Promise.allSettled([desktop.close(),browser.close()]);}};
}
