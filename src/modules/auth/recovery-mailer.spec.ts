import { jest } from '@jest/globals';
const sendMail=jest.fn<(options:unknown)=>Promise<{accepted:string[]}>>();
const createTransport=jest.fn<(options:unknown)=>{sendMail:typeof sendMail}>().mockReturnValue({sendMail});
jest.unstable_mockModule('nodemailer',()=>({default:{createTransport}}));
const {gmailRecoveryMailer}=await import('./recovery-mailer.js');
it('SMTP simulado: TLS obligatorio, sin logs, sin archivos/URLs y aceptación del destinatario esperado',async()=>{
  const mailer=gmailRecoveryMailer('synthetic@gmail.com','synthetic-app-password');
  expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({host:'smtp.gmail.com',port:465,secure:true,debug:false,logger:false,
    tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},disableFileAccess:true,disableUrlAccess:true}));
  sendMail.mockResolvedValue({accepted:['recipient@example.test']});
  expect(await mailer.send('recipient@example.test','00001234')).toBe(true);
  expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({to:'recipient@example.test',text:expect.stringContaining('00001234')}));
  sendMail.mockResolvedValue({accepted:[]});expect(await mailer.send('recipient@example.test','00001234')).toBe(false);
});
