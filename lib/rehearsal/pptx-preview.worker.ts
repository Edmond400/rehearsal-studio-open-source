import {parse} from '@web-ppt/core';

// Import the main parser so that its registered DrawingML chart parser is
// available in the worker. The upstream minimal worker omits that registration.
self.onmessage=async (event:MessageEvent<ArrayBuffer>)=>{
 try{
  const {dispose,...presentation}=await parse(event.data,{edit:true});
  self.postMessage({presentation});
 }catch(error){
  self.postMessage({error:(error as Error).message});
 }
};
