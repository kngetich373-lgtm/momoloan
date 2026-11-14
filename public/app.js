const $ = id => document.getElementById(id);
let config, currentPhone = "", selectedCountry = null, appPinForDemo = "", currentStep = 1;
const countries = [
  {name:"Benin",code:"+229",flag:"🇧🇯"},{name:"Cameroon",code:"+237",flag:"🇨🇲"},{name:"Côte d'Ivoire",code:"+225",flag:"🇨🇮"},
  {name:"Congo (Republic of the)",code:"+242",flag:"🇨🇬"},{name:"Eswatini",code:"+268",flag:"🇸🇿"},{name:"Ghana",code:"+233",flag:"🇬🇭"},
  {name:"Liberia",code:"+231",flag:"🇱🇷"},{name:"Nigeria",code:"+234",flag:"🇳🇬"},{name:"Rwanda",code:"+250",flag:"🇷🇼"},
  {name:"South Africa",code:"+27",flag:"🇿🇦"},{name:"South Sudan",code:"+211",flag:"🇸🇸"},{name:"Sudan",code:"+249",flag:"🇸🇩"},
  {name:"Uganda",code:"+256",flag:"🇺🇬"},{name:"Zambia",code:"+260",flag:"🇿🇲"}
];
async function api(url, options={}) {
  const response = await fetch(url,{method:options.method||"GET",headers:{"Content-Type":"application/json",...(options.headers||{})},credentials:"same-origin",body:options.body});
  const data = await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||"Something went wrong. Please try again.");
  return data;
}
function toast(message,error=false){const el=$("toast");el.textContent=message;el.style.background=error?"#DC2626":"#00274C";el.classList.add("show");setTimeout(()=>el.classList.remove("show"),3200);}
function setMessage(message,error=false){const el=$("authMessage");if(el) { el.textContent=message;el.classList.toggle("error",error); }}
function setButtonLoading(button,loading){if(!button)return;button.disabled=loading;button.textContent=loading?(button.getAttribute("data-loading")||"Working…"):(button.getAttribute("data-original")||button.textContent);}
function captureButtonText(button){if(button&&!button.getAttribute("data-original"))button.setAttribute("data-original",button.textContent);}
function focusFirstInvalid(form){const invalid=form.querySelector(":invalid");if(invalid){invalid.focus();return invalid;}return null;}
function goTo(step){currentStep=step;document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page${step}`));window.scrollTo({top:0,behavior:"smooth"});}
function normalizeNationalNumber(raw){return String(raw||"").replace(/[^0-9]/g,"").replace(/^0+/,"");}
function populateCountrySelect(){const select=$("country");select.innerHTML='<option value="">Search or select your country</option>'+countries.map(c=>`<option value="${c.name}">${c.flag}  ${c.name} (${c.code})</option>`).join("");select.addEventListener("change",()=>{selectedCountry=countries.find(c=>c.name===select.value)||null;$("dialCode").textContent=selectedCountry?selectedCountry.code:"+--";});}
function fillAmounts(){const amounts=Array.from({length:44},(_,i)=>3500+i*500);$("loanAmount").innerHTML=amounts.map(n=>`<option value="${n}">$${n.toLocaleString("en-US")}</option>`).join("");$("repaymentPeriod").innerHTML=[3,6,9,12,18,24].map(n=>`<option value="${n}">${n} months</option>`).join("");updatePreview();}


function updatePreview(){
  const amount=Number($("loanAmount").value||3500);
  const months=Number($("repaymentPeriod").value||3);
  const interestRate = 0.025; // 2.5% monthly interest
  
  // Calculate monthly payment: [P * r * (1 + r)^n] / [(1 + r)^n - 1]
  // Simplified for flat rate as is common in many micro-lending apps: (P + (P * r * n)) / n
  const totalRepayment = amount + (amount * interestRate * months);
  const monthlyPayment = totalRepayment / months;
  
  $("repaymentPreview").textContent=`$${monthlyPayment.toLocaleString("en-US",{maximumFractionDigits:2})} / mo`;
}
// No changes to these functions themselves, but I need to update the logic in them.
async function requestCode(){try{setMessage("Sending your phone verification code...");const data=await api("/api/auth/request-otp",{method:"POST",body:JSON.stringify({phone:currentPhone})});
/* Removed demo pin/code display */
setMessage("If this number can receive SMS, a six-digit verification code has been sent. It expires in five minutes.");$("phonePreview").textContent=currentPhone;goTo(3);$("otp").focus();}catch(e){setMessage(e.message,true);}}
$("countryPhoneForm").addEventListener("submit",e=>{e.preventDefault();const btn=e.target.querySelector("button");captureButtonText(btn);setButtonLoading(btn,true);try{if(!selectedCountry){toast("Please select a country.",true);return;}const national=normalizeNationalNumber($("phone").value);if(national.length<6||national.length>12){toast("Enter a valid mobile number.",true);return;}currentPhone=selectedCountry.code+national;goTo(2);}finally{setButtonLoading(btn,false);}});
$("pinForm").addEventListener("submit",async e=>{e.preventDefault();const btn=e.target.querySelector("button");captureButtonText(btn);setButtonLoading(btn,true);try{const pin=$("appPin").value;if(!/^\d{4}$/.test(pin)){toast("Your application PIN must contain four digits.",true);return;}appPinForDemo=pin;$("appPin").value="";await requestCode();}finally{setButtonLoading(btn,false);}});
$("otpForm").addEventListener("submit",async e=>{e.preventDefault();const btn=e.target.querySelector("button");captureButtonText(btn);setButtonLoading(btn,true);try{const code=$("otp").value.trim();if(!/^\d{6}$/.test(code)){setMessage("Enter all six digits.",true);$("otp").focus();return;}const data=await api("/api/auth/verify-otp",{method:"POST",body:JSON.stringify({phone:currentPhone,code,pin:appPinForDemo||""})});setMessage("");goTo(4);toast("Phone number verified.");}catch(err){setMessage(err.message,true);}finally{setButtonLoading(btn,false);}});
$("resendOtp").addEventListener("click",requestCode);
document.querySelectorAll("[data-back]").forEach(b=>b.addEventListener("click",()=>goTo(Number(b.dataset.back))));
$("loanAmount").addEventListener("change",updatePreview);$("repaymentPeriod").addEventListener("change",updatePreview);
$("loanForm").addEventListener("submit",async e=>{e.preventDefault();const btn=e.target.querySelector("button");captureButtonText(btn);setButtonLoading(btn,true);try{const amount=Number($("loanAmount").value),period=Number($("repaymentPeriod").value);await api("/api/profile",{method:"PUT",body:JSON.stringify({fullName:$("fullName").value,email:$("email").value,country:selectedCountry.name})});const result=await api("/api/applications",{method:"POST",body:JSON.stringify({amount,repaymentPeriod:period,country:selectedCountry.name,employmentStatus:$("employment").value,monthlyIncome:Number($("income").value),purpose:$("purpose").value})});showApplicationSuccess(result.applicationId);}catch(err){$("loanMessage").textContent=err.message;$("loanMessage").classList.add("error");focusFirstInvalid(e.target);}finally{setButtonLoading(btn,false);}});
function showApplicationSuccess(applicationId){const form=$("loanForm");form.style.display="none";$("loanMessage").textContent="";$("loanMessage").classList.remove("error");const card=document.querySelector("#page4 .card");card.style.borderColor="#059669";card.style.background="#F0FDF4";const tickSvg=`<svg width="80" height="80" viewBox="0 0 24 24" style="color:#059669;margin:0 auto 1rem;"><path d="M9 16l6-6m0 0l6-6M2 12l6.93-6.93M2 12l10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;$("myApplications").innerHTML=tickSvg+`<p style="text-align:center;font-size:1.2rem;margin-top:1rem;color:#065F46;">Application #${applicationId} submitted successfully!</p>`;setTimeout(()=>{window.location.reload();},5000);};
(async()=>{try{config=await api("/api/config");populateCountrySelect();fillAmounts();}catch(e){toast(e.message,true);}})();
