#import <Foundation/Foundation.h>
#import <PushKit/PushKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface GlobalQallVoipNativeBridge : NSObject

+ (void)forwardUpdatedCredentials:(PKPushCredentials *)credentials
                          forType:(PKPushType)type;

+ (void)forwardIncomingPayload:(PKPushPayload *)payload
                       forType:(PKPushType)type;

+ (void)reportIncomingCallWithUUID:(NSString *)uuid
                            handle:(NSString *)handle
                        callerName:(NSString *)callerName
                          hasVideo:(BOOL)hasVideo
                           payload:(NSDictionary *)payload
                        completion:(void (^)(void))completion;

@end

NS_ASSUME_NONNULL_END
