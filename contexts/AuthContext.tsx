import type { Session, User } from "@supabase/supabase-js";
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { deactivateVoipPushToken, initializeVoipPushEvents, setVoipPushUser } from "../lib/voipPush";
import { supabase } from "../lib/supabase";

type AuthContextValue={session:Session|null;user:User|null;loading:boolean;signOut:()=>Promise<void>};
const AuthContext=createContext<AuthContextValue|undefined>(undefined);
type AuthProviderProps={children:ReactNode};
export function AuthProvider({children}:AuthProviderProps){
 const [session,setSession]=useState<Session|null>(null); const [loading,setLoading]=useState(true);
 useEffect(()=>initializeVoipPushEvents(),[]);
 useEffect(()=>{setVoipPushUser(session?.user?.id??null)},[session?.user?.id]);
 useEffect(()=>{let mounted=true; async function loadSession(){const {data:{session:currentSession}}=await supabase.auth.getSession(); if(mounted){setSession(currentSession);setLoading(false)}} void loadSession(); const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,updatedSession)=>{setSession(updatedSession);setLoading(false)}); return()=>{mounted=false;subscription.unsubscribe()}},[]);
 async function signOut(){await deactivateVoipPushToken(); const {error}=await supabase.auth.signOut(); if(error) throw error;}
 const value=useMemo(()=>({session,user:session?.user??null,loading,signOut}),[session,loading]);
 return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth():AuthContextValue{const context=useContext(AuthContext);if(!context)throw new Error("useAuth must be used inside AuthProvider.");return context;}
