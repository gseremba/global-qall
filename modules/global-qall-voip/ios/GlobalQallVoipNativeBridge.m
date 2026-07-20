#import "GlobalQallVoipNativeBridge.h"
#import "RNVoipPushNotificationManager.h"
#import "RNCallKeep.h"

@implementation GlobalQallVoipNativeBridge

+ (void)forwardUpdatedCredentials:(PKPushCredentials *)credentials
                          forType:(PKPushType)type
{
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials
                                                   forType:type];
}

+ (void)forwardIncomingPayload:(PKPushPayload *)payload
                       forType:(PKPushType)type
{
  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload
                                                            forType:type];
}

+ (void)reportIncomingCallWithUUID:(NSString *)uuid
                            handle:(NSString *)handle
                        callerName:(NSString *)callerName
                          hasVideo:(BOOL)hasVideo
                           payload:(NSDictionary *)payload
                        completion:(void (^)(void))completion
{
  [RNCallKeep reportNewIncomingCall:uuid
                             handle:handle
                         handleType:@"generic"
                           hasVideo:hasVideo
                localizedCallerName:callerName
                    supportsHolding:YES
                       supportsDTMF:YES
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:payload
              withCompletionHandler:completion];
}

@end
