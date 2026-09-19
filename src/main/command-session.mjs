import {randomUUID} from 'node:crypto';
import {classifyCommand,executeCommand} from './commands.mjs';

const reusable=new Set(['calendar','benchmark-open','benchmark','project','context','pause','resume','files']);
// Receipts belong to the main process. The renderer can name a completed
// command, but cannot turn an arbitrary script or model answer into a routine.
export function createCommandSession({service,knowledge,...actions}){
  const receipts=new Map();
  async function execute(text,{routineId}={}){
    const projects=service.snapshot().projects;
    let action=classifyCommand(text,projects),routine;
    if(routineId){
      routine=await knowledge.prepareRoutine(routineId);
    }else if(action.type==='unknown'){
      const projectId=service.snapshot().currentProjectId;
      routine=await knowledge.resolveRoutine(text,projectId);
      if(routine)routine=await knowledge.prepareRoutine(routine.id,{trigger:text,projectId});
    }
    if(routine){
      action=classifyCommand(routine.command,projects);
      if(!reusable.has(action.type)||action.type!==routine.actionType)throw new Error('This routine needs to be saved again after its command changed.');
      text=routine.command;
    }
    const result=await executeCommand(text,{service,...actions});
    // A failed ranking fetch or an empty search has not demonstrated a useful
    // successful action and must not offer a verified-routine receipt.
    const successful=reusable.has(action.type)&&!(result.kind==='files'&&!result.fileIds?.length)&&!(result.kind==='benchmark'&&result.failed);
    if(routine&&successful){
      try{await knowledge.useRoutine(routine.id,{expectedCommand:routine.command,expectedUpdatedAt:routine.updatedAt});}
      catch(error){result.warning=`Command completed, but routine usage could not be saved: ${error.message}`;}
    }
    if(successful){
      const id=randomUUID();receipts.set(id,{command:text,action,at:Date.now(),projectId:service.snapshot().currentProjectId});
      while(receipts.size>100)receipts.delete(receipts.keys().next().value);
      return {...result,routineReceiptId:id,completedCommand:text,...(routine?{routineName:routine.name}:{})};
    }
    return result;
  }
  async function save({receiptId,name,trigger,projectId}){
    const receipt=receipts.get(receiptId);
    if(!receipt||Date.now()-receipt.at>3_600_000)throw new Error('Run the command successfully, then save it as a routine.');
    const current=classifyCommand(receipt.command,service.snapshot().projects);
    if(JSON.stringify(current)!==JSON.stringify(receipt.action))throw new Error('The workspace or command changed. Run it again first.');
    return knowledge.saveRoutine({name,trigger,projectId:projectId||null,command:receipt.command});
  }
  return {execute,save,runRoutine:id=>execute('',{routineId:id})};
}
