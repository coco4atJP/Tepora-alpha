/** Preserve legacy spaces until the user chooses a versioned preset. The saved
 * profile identity includes provider/endpoint/model/revision/dimensions/recipe
 * and context limit. A pipeline change must use a new version, never old vectors.
 * Unknown provider-managed model revisions cannot certify immutable weights.
 */
export const QWEN_RETRIEVAL_PREFIX='Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';
export function embeddingIdentity(profile){return profile.embeddingFormat?`tepora-memory:prefix12000:utf16:none:v1:${profile.identity}`:profile.identity;}
export function embeddingInputs(profile,inputs,purpose){
 if(!['query','document','ranking'].includes(purpose))throw Error('Invalid embedding purpose');
 return inputs.map((text,index)=>profile.embeddingFormat==='qwen3-retrieval-v1'&&(purpose==='query'||purpose==='ranking'&&index===0)?QWEN_RETRIEVAL_PREFIX+text:text);
}
