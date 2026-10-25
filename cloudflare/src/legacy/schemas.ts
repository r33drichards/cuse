/** Names and argument contracts from the pre-removal cuse goal/mailbox tools.
 * These schemas constrain execution; persisted tool descriptions grant no authority. */
const string={type:'string'};
const object=(properties:Record<string,unknown>,required:string[]=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const evidence=object({kind:{enum:['native-test','artifact','inspection','peer-review']},ref:{type:'string',minLength:1,maxLength:512},result:{enum:['pass','fail','blocked']}});
const schemas:Record<string,Record<string,unknown>>={
 irc_send:object({channel:string,text:string}),agent_list:object({}),agent_ask:object({channel:string,question:string}),goal_status:object({}),
 goal_update:{anyOf:[object({action:{const:'plan'},tasks:{type:'array',minItems:1,maxItems:49,items:object({id:{type:'string',minLength:1,maxLength:80},title:{type:'string',minLength:1,maxLength:1000},parent:string},['id','title'])}}),object({action:{const:'task'},id:string,state:{enum:['pending','working','done']},evidence:{type:'array',maxItems:8,items:evidence}},['action','id','state']),object({action:{const:'block'},reason:{type:'string',minLength:1,maxLength:1000}}),object({action:{const:'submit'}})]},
};
export function legacySchema(name:string){return schemas[name];}
